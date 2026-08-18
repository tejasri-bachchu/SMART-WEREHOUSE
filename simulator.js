/* ==========================================================================
   LOGIFORCE AI - WAREHOUSE SIMULATOR
   ========================================================================== */

const Simulator = {
  pickers: [],
  speed: 0, // 0 = paused, 1 = 1x, 2 = 2x, 5 = 5x
  timerId: null,
  tickRate: 1000, // base 1000ms
  gridWidth: 12,
  gridHeight: 10,
  activeExceptionOrder: null, // References the order currently causing a modal hold

  init() {
    // Spawn 3 Picker Agents at the charging hub (Row 0, Cols 5, 6, 7)
    this.pickers = [
      { id: "P-1", name: "Agent Alpha", x: 5, y: 0, state: "idle", assignedOrderId: null, path: [], pathIndex: 0, targetSku: null },
      { id: "P-2", name: "Agent Beta", x: 6, y: 0, state: "idle", assignedOrderId: null, path: [], pathIndex: 0, targetSku: null },
      { id: "P-3", name: "Agent Gamma", x: 7, y: 0, state: "idle", assignedOrderId: null, path: [], pathIndex: 0, targetSku: null }
    ];
  },

  setSpeed(newSpeed) {
    this.speed = newSpeed;
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    
    if (this.speed > 0) {
      const interval = this.tickRate / this.speed;
      this.timerId = setInterval(() => this.tick(), interval);
    }
    
    // Broadcast status change
    const event = new CustomEvent("simSpeedChanged", { detail: { speed: this.speed } });
    window.dispatchEvent(event);
  },

  tick() {
    if (this.speed === 0 || this.activeExceptionOrder) return;

    // 1. Refresh ages & priorities of waiting orders
    Orders.refreshQueuedPriorities();

    // 2. Generate random order under chance
    if (Math.random() < 0.08) {
      Orders.createRandomOrder();
    }

    // 3. Try allocating stock for any "created" orders
    const createdOrders = Orders.getOrdersByStage("created");
    createdOrders.forEach(order => {
      Orders.allocateInventory(order.id);
    });

    // 4. Assign idle pickers to allocated orders
    this.assignJobsToPickers();

    // 5. Update picker movement steps
    this.updatePickers();

    // 6. Advance orders through packing and quality check stages
    this.updatePostPickingStages();

    // Broadcast tick update to UI
    const event = new CustomEvent("simTick");
    window.dispatchEvent(event);
  },

  assignJobsToPickers() {
    const allocatedOrders = Orders.getOrdersByStage("allocated");
    if (allocatedOrders.length === 0) return;

    // Sort allocated orders by priority (highest first)
    allocatedOrders.sort((a, b) => b.priority - a.priority);

    for (const order of allocatedOrders) {
      // Find an idle picker
      const idlePicker = this.pickers.find(p => p.state === "idle");
      if (!idlePicker) break; // No pickers available

      // Assign picker to this order
      idlePicker.state = "picking";
      idlePicker.assignedOrderId = order.id;
      order.stage = "picking";
      order.pickerId = idlePicker.id;
      order.timeMetrics.pickingStart = Date.now();

      // Plot route path to collect items
      const pickPath = this.calculatePickingPath(idlePicker.x, idlePicker.y, order.items);
      idlePicker.path = pickPath;
      idlePicker.pathIndex = 0;

      // Log event
      Analytics.logOperation(`Picker ${idlePicker.name} assigned to Order ${order.id}. Path plotted (${pickPath.length} steps).`, "info");
      Orders.triggerUpdateEvents("orderPickingStarted", order);
    }
  },

  updatePickers() {
    this.pickers.forEach(picker => {
      if (picker.state === "idle") return;

      const order = Orders.queue.find(o => o.id === picker.assignedOrderId);
      if (!order) {
        // Safe reset if order was deleted/cancelled
        picker.state = "idle";
        picker.assignedOrderId = null;
        picker.path = [];
        picker.pathIndex = 0;
        return;
      }

      if (picker.pathIndex < picker.path.length) {
        // Move to the next coordinate in path
        const nextCoord = picker.path[picker.pathIndex];
        picker.x = nextCoord.x;
        picker.y = nextCoord.y;
        picker.pathIndex++;

        // Track heatmap analytics
        Analytics.incrementHeatmap(picker.x, picker.y);

        // Check if picker has arrived at an item rack they need to pick
        const itemNeededAtLocation = order.items.find(item => {
          const skuInfo = Inventory.getBySku(item.sku);
          return skuInfo && skuInfo.gridX === picker.x && skuInfo.gridY === picker.y;
        });

        if (itemNeededAtLocation) {
          // Trigger a random Damaged Item Exception (4% chance per item picked)
          if (Math.random() < 0.04 && !order.exceptionFlag) {
            this.triggerDamagedException(order, picker, itemNeededAtLocation.sku);
            return;
          }
        }
      } else {
        // Finished the path!
        if (picker.state === "picking") {
          // Finished collection, route back to packing station (Grid Row 9, Col 3)
          picker.state = "returning";
          const returnPath = this.findPath(picker.x, picker.y, 3, 9);
          picker.path = returnPath;
          picker.pathIndex = 0;
          
          Analytics.logOperation(`Picker ${picker.name} finished gathering items. Routing to Packing Bay.`, "info");
        } 
        else if (picker.state === "returning") {
          // Arrived at Packing station!
          order.stage = "packing";
          order.timeMetrics.packingStart = Date.now();
          
          // Release picker
          picker.state = "idle";
          picker.assignedOrderId = null;
          picker.path = [];
          picker.pathIndex = 0;

          Analytics.logOperation(`Picker ${picker.name} delivered items to Packing Bay. Order ${order.id} is packing.`, "success");
          Orders.triggerUpdateEvents("orderPackingStarted", order);
        }
      }
    });
  },

  updatePostPickingStages() {
    Orders.queue.forEach(order => {
      // 1. Process orders in packing
      if (order.stage === "packing") {
        const timeSpent = (Date.now() - order.timeMetrics.packingStart) / 1000 * this.speed;
        if (timeSpent > 5) { // 5 simulated seconds to pack
          order.stage = "qc";
          order.timeMetrics.qcStart = Date.now();
          Orders.triggerUpdateEvents("orderQcStarted", order);
          Analytics.logOperation(`Order ${order.id} packed. Routing to Quality Control inspection.`, "info");
        }
      }

      // 2. Process orders in QC
      if (order.stage === "qc" && !order.exceptionFlag) {
        const timeSpent = (Date.now() - order.timeMetrics.qcStart) / 1000 * this.speed;
        if (timeSpent > 4) { // 4 simulated seconds to inspect
          // Trigger a random QC failure (5% chance)
          if (Math.random() < 0.05) {
            this.triggerQcException(order);
          } else {
            // QC Passed -> Dispatch!
            this.dispatchOrder(order);
          }
        }
      }
    });
  },

  dispatchOrder(order) {
    order.stage = "dispatched";
    order.timeMetrics.dispatched = Date.now();
    Orders.completedCount++;
    
    // Add cycle time to analytics
    const cycleTimeSec = (order.timeMetrics.dispatched - order.timeMetrics.created) / 1000;
    Analytics.recordCycleTime(cycleTimeSec);

    Analytics.logOperation(`Order ${order.id} passed Quality Control and DISPATCHED! Total fulfillment cycle: ${cycleTimeSec.toFixed(1)}s`, "success");
    Orders.triggerUpdateEvents("orderDispatched", order);
  },

  /* ==========================================================================
     EXCEPTIONS DISPATCHERS
     ========================================================================== */
  triggerDamagedException(order, picker, sku) {
    this.setSpeed(0); // Pause simulation
    this.activeExceptionOrder = order;

    order.stage = "damaged_hold";
    order.exceptionFlag = {
      type: "damaged",
      sku: sku,
      pickerId: picker.id
    };

    Analytics.logOperation(`EXCEPTION: Picker ${picker.name} reports item ${sku} is damaged on Rack shelf! Simulator paused.`, "danger");
    
    // Fire event to open exception modal
    const event = new CustomEvent("exceptionRaised", { detail: { order: order } });
    window.dispatchEvent(event);
  },

  triggerQcException(order) {
    this.setSpeed(0); // Pause simulation
    this.activeExceptionOrder = order;

    order.stage = "qc_hold";
    order.exceptionFlag = {
      type: "qc_failure"
    };

    Analytics.logOperation(`EXCEPTION: Order ${order.id} failed Quality Control due to surface scratches. Simulator paused.`, "danger");

    // Fire event to open exception modal
    const event = new CustomEvent("exceptionRaised", { detail: { order: order } });
    window.dispatchEvent(event);
  },

  /* ==========================================================================
     PATHFINDING: BFS ROUTER AVOIDING OBSTACLES
     ========================================================================== */
  // Calculates sequential path coordinates visiting all items then returning to hub/exit
  calculatePickingPath(startX, startY, items) {
    let currentX = startX;
    let currentY = startY;
    let fullPath = [];

    // Order items by simple coordinate proximity (Nearest Neighbor heuristic for routing optimization)
    const itemsToPick = [...items];
    const orderedItems = [];

    while (itemsToPick.length > 0) {
      let nearestIndex = 0;
      let minDistance = Infinity;

      for (let i = 0; i < itemsToPick.length; i++) {
        const itemInfo = Inventory.getBySku(itemsToPick[i].sku);
        if (itemInfo) {
          const dist = Math.abs(currentX - itemInfo.gridX) + Math.abs(currentY - itemInfo.gridY);
          if (dist < minDistance) {
            minDistance = dist;
            nearestIndex = i;
          }
        }
      }

      orderedItems.push(itemsToPick.splice(nearestIndex, 1)[0]);
    }

    // Connect paths between items
    orderedItems.forEach(item => {
      const targetItem = Inventory.getBySku(item.sku);
      if (targetItem) {
        const leg = this.findPath(currentX, currentY, targetItem.gridX, targetItem.gridY);
        fullPath = fullPath.concat(leg);
        if (leg.length > 0) {
          const lastPoint = leg[leg.length - 1];
          currentX = lastPoint.x;
          currentY = lastPoint.y;
        }
      }
    });

    return fullPath;
  },

  // BFS search on grid
  findPath(startX, startY, endX, endY) {
    if (startX === endX && startY === endY) return [];

    const queue = [[{ x: startX, y: startY }]];
    const visited = new Set();
    visited.add(`${startX},${startY}`);

    const directions = [
      { x: 0, y: -1 }, // North
      { x: 0, y: 1 },  // South
      { x: -1, y: 0 }, // West
      { x: 1, y: 0 }   // East
    ];

    while (queue.length > 0) {
      const path = queue.shift();
      const current = path[path.length - 1];

      if (current.x === endX && current.y === endY) {
        // Found path, return coordinates excluding starting position
        return path.slice(1);
      }

      for (const dir of directions) {
        const nextX = current.x + dir.x;
        const nextY = current.y + dir.y;
        const posKey = `${nextX},${nextY}`;

        if (nextX >= 0 && nextX < this.gridWidth && nextY >= 0 && nextY < this.gridHeight) {
          if (!visited.has(posKey)) {
            // Determine if the cell is an obstacle (racks are obstacles, unless it is the target destination cell itself)
            const cell = Inventory.getCellInfo(nextX, nextY);
            const isObstacle = cell.type === "rack" && !(nextX === endX && nextY === endY);

            if (!isObstacle) {
              visited.add(posKey);
              queue.push([...path, { x: nextX, y: nextY }]);
            }
          }
        }
      }
    }

    // Fallback direct line if BFS fails (should not happen on our layout)
    return [{ x: endX, y: endY }];
  }
};
