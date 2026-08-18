/* ==========================================================================
   LOGIFORCE AI - ORDER PIPELINE MANAGER
   ========================================================================== */

const Orders = {
  queue: [],
  counter: 1001,
  completedCount: 0,
  stockSavedCount: 0, // Counts how many times we reallocated stock to resolve a bottleneck

  customers: [
    { name: "Nebula Aerospace", tier: "VIP" },
    { name: "Apex Surgical Systems", tier: "VIP" },
    { name: "Quantum Labs", tier: "VIP" },
    { name: "Nova Apparel Corp", tier: "Standard" },
    { name: "BioPharma Allied", tier: "Standard" },
    { name: "OmniRetail Global", tier: "Standard" },
    { name: "Grid Tech Electronics", tier: "Standard" },
    { name: "Zenith Food Suppliers", tier: "Standard" }
  ],

  createRandomOrder() {
    const customer = this.customers[Math.floor(Math.random() * this.customers.length)];
    const isExpress = Math.random() > 0.4; // 60% chance of express delivery
    
    // Choose 1-3 random items from inventory
    const inventorySkus = Inventory.getAll();
    const itemCount = Math.floor(Math.random() * 2) + 1; // 1 or 2 unique products
    const items = [];
    
    const shuffled = [...inventorySkus].sort(() => 0.5 - Math.random());
    for (let i = 0; i < itemCount; i++) {
      const targetItem = shuffled[i];
      // Random quantity between 2 and 8
      const qty = Math.floor(Math.random() * 6) + 2;
      items.push({
        sku: targetItem.sku,
        name: targetItem.name,
        qty: qty
      });
    }

    const orderId = `ORD-${this.counter++}`;
    const newOrder = {
      id: orderId,
      customer: customer.name,
      clientTier: customer.tier,
      isExpress: isExpress,
      items: items,
      createdAt: Date.now(),
      stage: "created", // created -> allocated -> picking -> packing -> qc -> dispatched
      priority: 0,
      priorityLabel: "Low",
      pickerId: null,
      timeMetrics: {
        created: Date.now(),
        allocated: null,
        pickingStart: null,
        packingStart: null,
        qcStart: null,
        dispatched: null
      },
      exceptionFlag: null // null or { type: "shortage" | "damaged" | "qc", sku?: string }
    };

    this.calculatePriority(newOrder);
    this.queue.push(newOrder);
    
    // Notify UI
    this.triggerUpdateEvents("orderCreated", newOrder);
    return newOrder;
  },

  calculatePriority(order) {
    let score = 0;
    
    // 1. VIP Customer Bonus
    if (order.clientTier === "VIP") {
      score += 45;
    }
    
    // 2. Shipping Type
    if (order.isExpress) {
      score += 35;
    }
    
    // 3. Order Age Weight (+1 point per 4 seconds of age, capped at 20)
    const ageInSecs = (Date.now() - order.createdAt) / 1000;
    const ageWeight = Math.min(20, Math.floor(ageInSecs / 4));
    score += ageWeight;

    order.priority = score;

    // Categorize priority label
    if (score >= 80) {
      order.priorityLabel = "Urgent";
    } else if (score >= 50) {
      order.priorityLabel = "High";
    } else if (score >= 30) {
      order.priorityLabel = "Medium";
    } else {
      order.priorityLabel = "Low";
    }
  },

  // Update priorities of all orders currently waiting in 'created' or 'shortage_hold'
  refreshQueuedPriorities() {
    this.queue.forEach(order => {
      if (order.stage === "created" || order.stage === "shortage_hold") {
        this.calculatePriority(order);
      }
    });

    // Sort the queue so higher priority orders are evaluated first
    // (Orders already active in picking/packing/etc. remain in their workflow, we only sorting queue for processing)
  },

  // Allocation engine: matches orders to stock
  allocateInventory(orderId) {
    const order = this.queue.find(o => o.id === orderId);
    if (!order || order.stage !== "created") return { success: false };

    let canAllocate = true;
    const shortageItems = [];

    // First pass: check if all items are fully available in inventory
    order.items.forEach(item => {
      const stockItem = Inventory.getBySku(item.sku);
      if (!stockItem || stockItem.qty < item.qty) {
        canAllocate = false;
        shortageItems.push({
          sku: item.sku,
          needed: item.qty,
          available: stockItem ? stockItem.qty : 0
        });
      }
    });

    if (canAllocate) {
      // Deduct stock and update order stage
      order.items.forEach(item => {
        Inventory.deductStock(item.sku, item.qty);
      });
      order.stage = "allocated";
      order.timeMetrics.allocated = Date.now();
      this.triggerUpdateEvents("orderAllocated", order);
      return { success: true };
    }

    // Shortage detected! Try priority reallocation logic (Competitive Twist)
    // Attempt to steal stock from lower priority orders that are in "allocated" state
    const resolvedThroughStealing = this.attemptPriorityReallocation(order, shortageItems);
    
    if (resolvedThroughStealing) {
      // Re-evaluate stock check
      let allStolenSucceeded = true;
      order.items.forEach(item => {
        const stockItem = Inventory.getBySku(item.sku);
        if (stockItem.qty < item.qty) {
          allStolenSucceeded = false;
        }
      });

      if (allStolenSucceeded) {
        order.items.forEach(item => {
          Inventory.deductStock(item.sku, item.qty);
        });
        order.stage = "allocated";
        order.timeMetrics.allocated = Date.now();
        this.stockSavedCount++;
        this.triggerUpdateEvents("orderAllocated", order);
        return { success: true, reallocated: true };
      }
    }

    // Still facing shortage -> trigger Exception state
    order.stage = "shortage_hold";
    order.exceptionFlag = {
      type: "shortage",
      sku: shortageItems[0].sku,
      needed: shortageItems[0].needed,
      available: shortageItems[0].available
    };
    
    this.triggerUpdateEvents("allocationShortage", order);
    return { success: false, exception: true, details: order.exceptionFlag };
  },

  // Priority Reallocation: Steals allocated items from lower-priority orders
  attemptPriorityReallocation(highOrder, shortages) {
    let reallocatedCount = 0;
    
    for (const shortage of shortages) {
      const neededQty = shortage.needed - shortage.available;
      let gatheredQty = 0;

      // Find lower priority orders that are allocated but haven't started picking yet
      const candidateOrders = this.queue
        .filter(o => o.stage === "allocated" && o.priority < highOrder.priority)
        .sort((a, b) => a.priority - b.priority); // Start with lowest priority candidate

      const selectedSteals = [];

      for (const lowOrder of candidateOrders) {
        const matchingItem = lowOrder.items.find(i => i.sku === shortage.sku);
        if (matchingItem) {
          const reclaimQty = matchingItem.qty;
          gatheredQty += reclaimQty;
          selectedSteals.push({ order: lowOrder, item: matchingItem });
          
          if (gatheredQty >= neededQty) break;
        }
      }

      // If we found enough stock to satisfy this item's shortage, execute the transfer
      if (gatheredQty >= neededQty) {
        selectedSteals.forEach(steal => {
          // Re-add stock back to inventory from lower order
          Inventory.addStock(steal.item.sku, steal.item.qty);
          
          // Revert lower order back to "created" state so it must re-seek allocation
          steal.order.stage = "created";
          steal.order.timeMetrics.allocated = null;
          this.triggerUpdateEvents("orderReverted", steal.order);
        });
        reallocatedCount++;
      }
    }

    // Return true if we resolved all shortages
    return reallocatedCount === shortages.length;
  },

  getOrdersByStage(stage) {
    return this.queue.filter(o => o.stage === stage);
  },

  triggerUpdateEvents(type, order) {
    const event = new CustomEvent(type, { detail: { order: order } });
    window.dispatchEvent(event);
  }
};
