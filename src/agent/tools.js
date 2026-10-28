"use strict";

const zupaApi = require("../zupaApiClient");
const sessions = require("../db/sessions");
const { classifyDeliveryTypes, searchZones } = require("./deliveryZones");

// Flattens zupa-api's nested category -> base_product -> sizes -> products
// response into a flat list the model can reason over cheaply. Price/stock
// here is always the live source of truth — the model never states a price
// itself, it only ever repeats what this returns.
function flattenMenu(categories) {
  const items = [];
  for (const category of categories || []) {
    for (const bp of category.products || []) {
      for (const [sizeName, products] of Object.entries(bp.sizes || {})) {
        for (const p of products || []) {
          const stock = Object.values(p.availableQuantity || {}).reduce(
            (sum, b) => sum + (b.quantity || 0),
            0,
          );
          items.push({
            productId: p.id,
            name: bp.name,
            size: sizeName,
            category: category.name,
            unitPrice: p.unitPrice,
            inStock: p.isUnlimited || stock > 0,
            stockQuantity: p.isUnlimited ? "unlimited" : stock,
          });
        }
      }
    }
  }
  return items;
}

function cartSubtotal(cart) {
  return cart.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
}

// Each tool: { definition (Anthropic tool schema), run(input, ctx) }.
// `ctx` = { phoneNumber, session } — session is always the latest row;
// tools that mutate state call sessions.updateSession() and return the
// fresh session so the orchestrator's loop stays in sync.
const tools = {
  get_menu: {
    definition: {
      name: "get_menu",
      description: "Get the live menu: items, sizes, prices, and stock. Always call this before telling a customer what's available or adding anything to their cart — never state a price from memory.",
      input_schema: {
        type: "object",
        properties: {
          category: { type: "string", description: "Optional — filter to one category name if the customer asked about a specific section of the menu." },
        },
      },
    },
    run: async (input) => {
      const categories = await zupaApi.fetchMenu({ includeSpecial: true });
      let items = flattenMenu(categories);
      if (input.category) {
        items = items.filter(
          (i) => i.category.toLowerCase() === input.category.toLowerCase(),
        );
      }
      return { items };
    },
  },

  search_delivery_zones: {
    definition: {
      name: "search_delivery_zones",
      description: "Find the delivery zone/area matching what the customer called their location (e.g. 'Lekki', 'Abijo', 'near Orchid hotel'), for a home-delivery order. Returns both regular delivery zones and Uber/Bolt on-demand tiers if nothing regular matches closely — these are a different, usually pricier, dispatch mechanism, so say so plainly if you offer one. Not used for pickup — use get_pickup_branches for that.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The area/neighborhood name as the customer described it." },
        },
        required: ["query"],
      },
    },
    run: async (input) => {
      const deliveryTypes = await zupaApi.fetchDeliveryTypes();
      const buckets = classifyDeliveryTypes(deliveryTypes);
      const matches = searchZones(buckets, input.query);
      if (!matches.length) {
        return { matches: [], note: "No close match — ask the customer for a nearby landmark or a different way to describe the area, then try again." };
      }
      return { matches };
    },
  },

  get_pickup_branches: {
    definition: {
      name: "get_pickup_branches",
      description: "List active pickup branches by name, for when a customer wants to pick up their order instead of having it delivered.",
      input_schema: { type: "object", properties: {} },
    },
    run: async () => {
      const branches = await zupaApi.fetchBranches();
      return { branches: branches.map((b) => ({ name: b.name, address: b.address })) };
    },
  },

  update_cart: {
    definition: {
      name: "update_cart",
      description: "Add, remove, or change the quantity of an item in the customer's cart. Always call get_menu first to get a valid productId, size, and current price — never invent these.",
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "set_quantity", "remove", "clear"] },
          productId: { type: "string", description: "Required for add/set_quantity/remove." },
          name: { type: "string", description: "Item name, from get_menu — required for add." },
          size: { type: "string", description: "Size, from get_menu — required for add." },
          unitPrice: { type: "number", description: "Unit price, from get_menu — required for add." },
          quantity: { type: "integer", description: "Required for add/set_quantity." },
          notes: { type: "string", description: "Optional special request for this item, e.g. 'extra spicy'." },
        },
        required: ["action"],
      },
    },
    run: async (input, ctx) => {
      let cart = [...ctx.session.cart];

      if (input.action === "clear") {
        cart = [];
      } else if (input.action === "remove") {
        cart = cart.filter(
          (i) => !(i.productId === input.productId && (!input.size || i.size === input.size)),
        );
      } else if (input.action === "set_quantity") {
        const existing = cart.find((i) => i.productId === input.productId && i.size === input.size);
        if (!existing) return { error: "That item isn't in the cart yet — use action 'add' instead." };
        if (input.quantity <= 0) {
          cart = cart.filter((i) => i !== existing);
        } else {
          existing.quantity = input.quantity;
        }
      } else if (input.action === "add") {
        if (!input.productId || !input.quantity || input.quantity <= 0) {
          return { error: "productId and a positive quantity are required to add an item." };
        }
        const existing = cart.find((i) => i.productId === input.productId && i.size === input.size);
        if (existing) {
          existing.quantity += input.quantity;
        } else {
          cart.push({
            productId: input.productId,
            name: input.name,
            size: input.size,
            unitPrice: input.unitPrice,
            quantity: input.quantity,
            notes: input.notes || null,
          });
        }
      }

      const session = sessions.updateSession(ctx.phoneNumber, { cart });
      return { cart: session.cart, subtotal: cartSubtotal(session.cart) };
    },
  },

  get_cart_summary: {
    definition: {
      name: "get_cart_summary",
      description: "Get the current cart contents and subtotal. Use this to read the order back to the customer for confirmation before creating it — delivery fee is finalized when the order is created.",
      input_schema: { type: "object", properties: {} },
    },
    run: async (input, ctx) => {
      return { cart: ctx.session.cart, subtotal: cartSubtotal(ctx.session.cart) };
    },
  },

  confirm_order_details: {
    definition: {
      name: "confirm_order_details",
      description: "Lock in the cart and delivery/pickup details once the customer has confirmed them, and get the exact total to quote for payment. This does NOT create an order — nothing is created in the system yet. The order is only ever created by check_payment, and only if it finds a matching transfer. Call this, read the returned total back to the customer with the payment instructions, and do not call create anything else until they say they've paid.",
      input_schema: {
        type: "object",
        properties: {
          customerName: { type: "string" },
          customerPhoneNumber: { type: "string", description: "The customer's WhatsApp number, digits only." },
          isPickup: { type: "boolean" },
          pickupBranchName: { type: "string", description: "Required if isPickup is true — from get_pickup_branches." },
          deliveryZoneId: { type: "string", description: "Required if isPickup is false — the id of the matched zone/tier from search_delivery_zones." },
          deliveryZoneName: { type: "string", description: "The matched zone's name, for your own reference when confirming with the customer." },
          deliveryAddress: { type: "string", description: "Required if isPickup is false — the customer's actual street address/landmark within that zone, for the rider." },
          recipientName: { type: "string", description: "Only if this is a gift order for someone else." },
          recipientPhoneNumber: { type: "string" },
          couponCode: { type: "string" },
          specialNote: { type: "string" },
        },
        required: ["customerName", "customerPhoneNumber"],
      },
    },
    run: async (input, ctx) => {
      if (!ctx.session.cart.length) {
        return { error: "The cart is empty — add items before confirming order details." };
      }
      if (!input.isPickup && !input.deliveryZoneId) {
        return { error: "deliveryZoneId is required for delivery orders — call search_delivery_zones first." };
      }
      if (input.isPickup && !input.pickupBranchName) {
        return { error: "pickupBranchName is required for pickup orders — call get_pickup_branches first." };
      }

      let deliveryFee = 0;
      if (!input.isPickup) {
        // Re-resolved here rather than trusting whatever price the model
        // last saw from search_delivery_zones — the fee that determines how
        // much the customer must pay has to come from the live source,
        // same discipline as menu prices.
        const deliveryTypes = await zupaApi.fetchDeliveryTypes();
        const match = deliveryTypes.find((dt) => dt.id === input.deliveryZoneId);
        if (!match) {
          return { error: "That delivery zone id is no longer valid — call search_delivery_zones again." };
        }
        deliveryFee = match.price;
      }

      const pendingOrder = {
        customerName: input.customerName,
        customerPhoneNumber: input.customerPhoneNumber,
        isPickup: !!input.isPickup,
        pickupBranchName: input.pickupBranchName || null,
        deliveryZoneId: input.isPickup ? null : input.deliveryZoneId,
        deliveryZoneName: input.deliveryZoneName || null,
        deliveryFee,
        deliveryAddress: input.deliveryAddress || null,
        recipientName: input.recipientName || null,
        recipientPhoneNumber: input.recipientPhoneNumber || null,
        couponCode: input.couponCode || null,
        specialNote: input.specialNote || "",
      };

      const session = sessions.updateSession(ctx.phoneNumber, { pendingOrder });
      const subtotal = cartSubtotal(session.cart);

      return {
        cart: session.cart,
        subtotal,
        deliveryFee,
        total: subtotal + deliveryFee,
        note: "Nothing has been created yet. Read this total back to the customer with the payment instructions, then call check_payment only after they say they've paid.",
      };
    },
  },

  check_payment: {
    definition: {
      name: "check_payment",
      description: "Check for a matching bank transfer after the customer says they've paid. This is the ONLY action that ever creates the order — it does so automatically, with the payment already attached, but only if a match is found. Requires confirm_order_details to have been called first. Safe to call again if it doesn't find a match the first time.",
      input_schema: { type: "object", properties: {} },
    },
    run: async (input, ctx) => {
      if (ctx.session.orderId) {
        // Already created by an earlier successful call — never re-create
        // or re-verify.
        return { matched: true, alreadyCreated: true, orderNumber: ctx.session.orderNumber };
      }

      const pending = ctx.session.pendingOrder;
      if (!pending) {
        return { error: "Call confirm_order_details first — there's nothing to check payment against yet." };
      }

      const subtotal = cartSubtotal(ctx.session.cart);
      const totalPrice = subtotal + pending.deliveryFee;

      const result = await zupaApi.verifyPayment({
        customerName: pending.customerName,
        totalPrice,
        deliveryPrice: pending.deliveryFee,
        couponCode: pending.couponCode || undefined,
      });

      if (!result.matched) {
        return result;
      }

      const transactionRef = result.combined
        ? result.payments.map((p) => p.transactionRef)
        : result.transactionRef;

      // The one and only place an order is ever created in this whole
      // service — and only reached after a payment match, with the
      // reference attached from the start. No code path exists that calls
      // zupaApi.createOrder without one.
      const clientReference = ctx.session.clientReference || `wa-${ctx.phoneNumber}-${ctx.session.createdAt}`;
      const orderResult = await zupaApi.createOrder({
        customer: { name: pending.customerName, phoneNumber: pending.customerPhoneNumber },
        order: {
          items: ctx.session.cart.map((i) => ({ productId: i.productId, quantity: i.quantity })),
          paymentReference: transactionRef,
          couponCode: pending.couponCode || undefined,
          specialNote: pending.specialNote || "",
        },
        address: {
          isPickup: pending.isPickup,
          pickupStore: pending.pickupBranchName,
          deliveryAddress: pending.deliveryAddress,
          cityId: pending.isPickup ? undefined : pending.deliveryZoneId,
        },
        recipient: pending.recipientName
          ? { name: pending.recipientName, phoneNumber: pending.recipientPhoneNumber }
          : null,
        clientReference,
      });

      sessions.updateSession(ctx.phoneNumber, {
        orderId: orderResult.orderId,
        orderNumber: orderResult.orderNumber,
        clientReference,
        paymentStatus: "paid",
      });

      console.log(`[check_payment] order ${orderResult.orderNumber} created for ${ctx.phoneNumber} (ref=${clientReference})`);
      return { ...result, orderCreated: true, orderNumber: orderResult.orderNumber };
    },
  },

  get_order_status: {
    definition: {
      name: "get_order_status",
      description: "Look up this customer's recent orders and their current status (pending, processing, ready for dispatch, dispatched, delivered, cancelled), including rider name/phone and ETA once dispatched. Use this whenever a customer asks about an existing order — 'where's my order', 'status of my last order', 'has it been dispatched' — instead of escalating to a human.",
      input_schema: {
        type: "object",
        properties: {
          phoneNumber: {
            type: "string",
            description: "Only set this if the customer explicitly says the order was placed under a different number than the one they're messaging from.",
          },
        },
      },
    },
    run: async (input, ctx) => {
      const phoneNumber = input.phoneNumber || ctx.phoneNumber;
      const result = await zupaApi.fetchOrderStatus(phoneNumber);
      if (!result.found) {
        return { found: false, note: "No customer record found for this phone number — double-check it with the customer, or escalate if they're sure it's right." };
      }
      if (!result.orders.length) {
        return { found: true, orders: [], note: "This customer exists but has no orders yet." };
      }
      return result;
    },
  },

  escalate_to_human: {
    definition: {
      name: "escalate_to_human",
      description: "Hand this conversation to a human teammate and stop responding yourself. Use for any complaint/refund, modifying or cancelling an already-placed order, a bulk/corporate request, an explicit ask to talk to a person, or anything you're not confident about.",
      input_schema: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Short, specific reason — this is what the teammate sees first." },
        },
        required: ["reason"],
      },
    },
    run: async (input, ctx) => {
      sessions.updateSession(ctx.phoneNumber, {
        mode: "human_handoff",
        escalatedAt: Date.now(),
        escalationReason: input.reason,
      });

      console.log(`[escalate_to_human] ${ctx.phoneNumber}: ${input.reason}`);
      try {
        await zupaApi.postSystemNote(
          ctx.phoneNumber,
          `AI escalated — ${input.reason}`,
          { orderNumber: ctx.session.orderNumber, mode: "human_handoff" },
        );
      } catch (e) {
        console.error("[escalate_to_human] failed to post system note:", e.message);
      }

      return { escalated: true };
    },
  },
};

module.exports = { tools, cartSubtotal };
