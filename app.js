/* ==========================================================================
   LOGIFORCE AI - MAIN APPLICATION CONTROLLER
   ========================================================================== */

document.addEventListener("DOMContentLoaded", () => {
  // Initialize Core Engines
  Inventory.init();
  Simulator.init();
  App.init();
});

const App = {
  activeTab: "overview",
  selectedGridCell: null,

  init() {
    // 1. Setup Tab Switching Navigation
    const navItems = document.querySelectorAll(".nav-item");
    navItems.forEach(item => {
      item.addEventListener("click", (e) => {
        e.preventDefault();
        const targetTab = item.getAttribute("data-tab");
        this.switchTab(targetTab);
      });
    });

    // Overview "View Full Map" redirection link
    const lnkFullMap = document.getElementById("lnk-view-full-map");
    if (lnkFullMap) {
      lnkFullMap.addEventListener("click", () => {
        this.switchTab("warehouse");
      });
    }

    // 2. Setup Simulation Controls
    document.getElementById("btn-speed-pause").addEventListener("click", () => Simulator.setSpeed(0));
    document.getElementById("btn-speed-1x").addEventListener("click", () => Simulator.setSpeed(1));
    document.getElementById("btn-speed-2x").addEventListener("click", () => Simulator.setSpeed(2));
    document.getElementById("btn-speed-5x").addEventListener("click", () => Simulator.setSpeed(5));

    // 3. Quick Actions
    document.getElementById("btn-trigger-order").addEventListener("click", () => {
      const order = Orders.createRandomOrder();
      Analytics.logOperation(`Manual Order ${order.id} generated for client ${order.customer}.`, "info");
    });

    document.getElementById("btn-trigger-restock").addEventListener("click", () => {
      Inventory.restockAll();
      Analytics.logOperation("All inventory SKUs restocked to maximum capacity.", "success");
    });

    // 4. Register Event Listeners
    window.addEventListener("simSpeedChanged", (e) => this.updateSpeedUI(e.detail.speed));
    window.addEventListener("simTick", () => this.onSimTick());
    window.addEventListener("logAdded", (e) => this.onLogAdded(e.detail));
    window.addEventListener("stockUpdated", () => this.renderInventoryTable());
    window.addEventListener("exceptionRaised", (e) => this.onExceptionRaised(e.detail.order));

    // Bind exception resolution global handlers for modal buttons
    window.resolveException = (decision) => this.handleExceptionResolution(decision);

    // Search and Filter Events for Inventory
    document.getElementById("inventory-search").addEventListener("input", () => this.renderInventoryTable());
    document.getElementById("inventory-filter-category").addEventListener("change", () => this.renderInventoryTable());
    document.getElementById("inventory-filter-stock").addEventListener("change", () => this.renderInventoryTable());

    // 5. Initial Rendering
    this.renderGrids();
    this.renderInventoryTable();
    this.renderPipelineBoard();
    this.renderHeatmap();

    // Spawn 2 initial orders to populate dashboard
    Orders.createRandomOrder();
    Orders.createRandomOrder();

    // Start simulation at speed 1x
    Simulator.setSpeed(1);

    Analytics.logOperation("LogiForce Operations Dashboard loaded successfully. Simulation speed set to 1x.", "info");
  },

  switchTab(tabId) {
    this.activeTab = tabId;

    // Toggle nav active state
    document.querySelectorAll(".nav-item").forEach(nav => {
      if (nav.getAttribute("data-tab") === tabId) {
        nav.classList.add("active");
      } else {
        nav.classList.remove("active");
      }
    });

    // Toggle views
    document.querySelectorAll(".view-panel").forEach(panel => {
      if (panel.id === `view-${tabId}`) {
        panel.classList.add("active");
      } else {
        panel.classList.remove("active");
      }
    });

    // Update Header Text
    const titleMap = {
      overview: { t: "Overview Dashboard", d: "Real-time monitoring and smart scheduling hub" },
      warehouse: { t: "Warehouse Floor Map", d: "Interactive 2D robot routing and racking zones viewer" },
      inventory: { t: "Inventory Control", d: "Sku stocking thresholds, restocks, and catalog monitoring" },
      orders: { t: "Order Pipeline Board", d: "Track order cards through picking, packing, and quality checks" },
      analytics: { t: "Operational Analytics", d: "Warehouse performance, average speed, and bottleneck indices" }
    };

    document.getElementById("current-view-title").textContent = titleMap[tabId].t;
    document.querySelector(".view-description").textContent = titleMap[tabId].d;

    // Force re-renders of views if active
    if (tabId === "warehouse") {
      this.renderGrids();
      this.inspectCell(5, 0); // inspect hub by default
    } else if (tabId === "inventory") {
      this.renderInventoryTable();
    } else if (tabId === "orders") {
      this.renderPipelineBoard();
    } else if (tabId === "analytics") {
      this.renderHeatmap();
      Analytics.updateTimelineChart();
    }
  },

  updateSpeedUI(speed) {
    const btnIds = {
      0: "btn-speed-pause",
      1: "btn-speed-1x",
      2: "btn-speed-2x",
      5: "btn-speed-5x"
    };

    document.querySelectorAll(".sim-speed-control button").forEach(btn => {
      btn.classList.remove("active");
    });

    const activeBtn = document.getElementById(btnIds[speed]);
    if (activeBtn) activeBtn.classList.add("active");
  },

  onSimTick() {
    // 1. Update Overview KPIs
    document.getElementById("stat-active-exceptions").textContent = Orders.queue.filter(o => o.stage.endsWith("_hold")).length;
    document.getElementById("stat-active-orders").textContent = Orders.queue.filter(o => o.stage !== "dispatched").length;
    document.getElementById("stat-unallocated-orders").textContent = `${Orders.getOrdersByStage("created").length} Pending Allocation`;
    document.getElementById("stat-dispatched-orders").textContent = Orders.completedCount;
    
    const lowStockCount = Inventory.getLowStockItems().length;
    document.getElementById("stat-low-stock").textContent = lowStockCount;
    document.getElementById("stat-total-sku").textContent = `${Inventory.getAll().length} SKUs Monitored`;

    const totalProcessed = Orders.completedCount;
    document.getElementById("stat-fulfillment-rate").textContent = totalProcessed > 0 ? "100% Accuracy Rate" : "Awaiting Deliveries";

    // 2. Refresh active UI elements depending on active view tab
    this.renderMinimap();

    if (this.activeTab === "warehouse") {
      this.renderFloorGrid();
      this.updateInspector();
    } else if (this.activeTab === "orders") {
      this.renderPipelineBoard();
    } else if (this.activeTab === "inventory") {
      this.renderInventoryTable();
    } else if (this.activeTab === "analytics") {
      this.renderHeatmap();
      this.renderAnalyticsKPIs();
      Analytics.updateTimelineChart();
    }

    // 3. Always update Overview page bottleneck bars
    this.renderBottlenecks();
  },

  onLogAdded(log) {
    const feed = document.getElementById("overview-feed");
    if (!feed) return;

    // Remove empty state if present
    const emptyState = feed.querySelector(".empty-state");
    if (emptyState) emptyState.remove();

    const logRow = document.createElement("div");
    logRow.className = `feed-row ${log.type}`;
    logRow.innerHTML = `
      <span class="feed-time">${log.time}</span>
      <span class="feed-text">${log.text}</span>
    `;

    feed.insertBefore(logRow, feed.firstChild);
    
    // Update count label
    document.getElementById("feed-count").textContent = `${feed.children.length} events`;
  },

  /* ==========================================================================
     UI RENDERING MODULES
     ========================================================================== */
  renderGrids() {
    this.renderMinimap();
    this.renderFloorGrid();
  },

  // Overview page visual minimap
  renderMinimap() {
    const container = document.getElementById("minimap-grid");
    if (!container) return;

    let html = '<div class="minimap-wrapper">';
    for (let y = 0; y < Simulator.gridHeight; y++) {
      for (let x = 0; x < Simulator.gridWidth; x++) {
        const cellInfo = Inventory.getCellInfo(x, y);
        let cellClass = "minimap-cell";
        
        if (cellInfo.type === "rack") {
          cellClass += ` rack-${cellInfo.category}`;
        } else if (cellInfo.type === "packing") {
          cellClass += " minimap-packing";
        } else if (cellInfo.type === "dispatch") {
          cellClass += " minimap-dispatch";
        }

        // Draw picker dot overlay if picker is at coordinate
        const activePicker = Simulator.pickers.find(p => p.x === x && p.y === y);
        let pickerHtml = "";
        if (activePicker) {
          pickerHtml = `<span class="minimap-picker animate-pulse" style="box-shadow: 0 0 6px ${activePicker.state === "picking" ? "var(--color-warning)" : activePicker.state === "returning" ? "var(--color-success)" : "var(--accent-cyan)"}"></span>`;
        }

        html += `<div class="${cellClass}">${pickerHtml}</div>`;
      }
    }
    html += "</div>";
    container.innerHTML = html;
  },

  // Main interactive Floor map grid
  renderFloorGrid() {
    const container = document.getElementById("warehouse-interactive-grid");
    if (!container) return;
    container.innerHTML = "";

    for (let y = 0; y < Simulator.gridHeight; y++) {
      for (let x = 0; x < Simulator.gridWidth; x++) {
        const cellInfo = Inventory.getCellInfo(x, y);
        const cell = document.createElement("div");
        cell.className = "grid-cell";
        cell.setAttribute("data-x", x);
        cell.setAttribute("data-y", y);

        // Styling based on cell types
        if (cellInfo.type === "rack") {
          cell.classList.add("rack", `rack-${cellInfo.category}`);
          cell.textContent = cellInfo.item.sku;
        } else if (cellInfo.type === "packing") {
          cell.classList.add("zone-packing");
          cell.textContent = "Pack";
        } else if (cellInfo.type === "dispatch") {
          cell.classList.add("zone-dispatch");
          cell.textContent = "Ship";
        } else if (cellInfo.type === "hub") {
          cell.classList.add("zone-hub");
          cell.textContent = "Hub";
        }

        // Highlight cells if they belong to any active picking routes
        Simulator.pickers.forEach(picker => {
          if (picker.state !== "idle") {
            const pathNode = picker.path.find(node => node.x === x && node.y === y);
            if (pathNode) {
              cell.classList.add("picking-path");
            }
          }
        });

        // Overlay moving picker avatar dots
        const pickerHere = Simulator.pickers.find(p => p.x === x && p.y === y);
        if (pickerHere) {
          const avatar = document.createElement("div");
          avatar.className = `grid-picker-agent state-${pickerHere.state}`;
          avatar.textContent = pickerHere.id.split("-")[1]; // display P number
          cell.appendChild(avatar);
        }

        // Event listener for click inspection
        cell.addEventListener("click", () => this.inspectCell(x, y));

        container.appendChild(cell);
      }
    }
  },

  inspectCell(x, y) {
    this.selectedGridCell = { x, y };
    
    // Highlight grid selection border (CSS handle can search for data attributes)
    const elements = document.querySelectorAll(".grid-cell");
    elements.forEach(el => el.style.borderColor = "");
    
    const selectedEl = document.querySelector(`.grid-cell[data-x='${x}'][data-y='${y}']`);
    if (selectedEl) {
      selectedEl.style.borderColor = "var(--accent-cyan)";
    }

    this.updateInspector();
  },

  updateInspector() {
    const inspector = document.getElementById("map-inspector");
    const body = document.getElementById("inspector-body");
    const typeLabel = document.getElementById("inspector-type");
    if (!body || !this.selectedGridCell) return;

    const { x, y } = this.selectedGridCell;
    const cellInfo = Inventory.getCellInfo(x, y);

    // Check if picker agent occupies this cell
    const activePicker = Simulator.pickers.find(p => p.x === x && p.y === y);

    if (activePicker) {
      typeLabel.textContent = "Agent Bot";
      let statusClass = "text-info";
      if (activePicker.state === "picking") statusClass = "text-warning";
      if (activePicker.state === "returning") statusClass = "text-success";

      body.innerHTML = `
        <div class="inspector-section">
          <h4>Agent Details</h4>
          <div class="inspector-row"><span class="label">ID:</span><span class="val">${activePicker.id}</span></div>
          <div class="inspector-row"><span class="label">Callsign:</span><span class="val">${activePicker.name}</span></div>
          <div class="inspector-row"><span class="label">Position:</span><span class="val">Row ${y}, Col ${x}</span></div>
          <div class="inspector-row"><span class="label">Workflow State:</span><span class="val ${statusClass}">${activePicker.state.toUpperCase()}</span></div>
        </div>
        ${activePicker.assignedOrderId ? `
        <div class="inspector-section">
          <h4>Active Workload</h4>
          <div class="inspector-row"><span class="label">Fulfilling:</span><span class="val">${activePicker.assignedOrderId}</span></div>
          <div class="inspector-row"><span class="label">Remaining Steps:</span><span class="val">${activePicker.path.length - activePicker.pathIndex} left</span></div>
        </div>
        ` : ""}
      `;
    } 
    else if (cellInfo.type === "rack") {
      typeLabel.textContent = "Rack Shelf";
      const item = cellInfo.item;
      const pct = (item.qty / item.capacity) * 100;
      let barColor = "var(--color-success)";
      if (pct < 30) barColor = "var(--color-danger)";
      else if (pct < 60) barColor = "var(--color-warning)";

      body.innerHTML = `
        <div class="inspector-section">
          <h4>SKU Properties</h4>
          <div class="inspector-row"><span class="label">SKU ID:</span><span class="val">${item.sku}</span></div>
          <div class="inspector-row"><span class="label">Product Name:</span><span class="val">${item.name}</span></div>
          <div class="inspector-row"><span class="label">Category:</span><span class="val">${item.category.toUpperCase()}</span></div>
          <div class="inspector-row"><span class="label">Shelf Bay:</span><span class="val">Aisle ${Math.ceil(x/2)}, Row ${y}</span></div>
        </div>
        <div class="inspector-section">
          <h4>Stock Levels</h4>
          <div class="inspector-row"><span class="label">In Stock:</span><span class="val">${item.qty} units</span></div>
          <div class="inspector-row"><span class="label">Shelf Cap:</span><span class="val">${item.capacity} units</span></div>
          <div class="inspector-row"><span class="label">Capacity Fill:</span><span class="val">${pct.toFixed(0)}%</span></div>
          <div class="inspector-progress-track">
            <div class="inspector-progress-fill" style="width: ${pct}%; background: ${barColor};"></div>
          </div>
        </div>
      `;
    } 
    else {
      typeLabel.textContent = "Warehouse Floor";
      body.innerHTML = `
        <div class="inspector-section">
          <h4>Zone Description</h4>
          <div class="inspector-row"><span class="label">Cell Type:</span><span class="val">${cellInfo.name}</span></div>
          <div class="inspector-row"><span class="label">Grid Coordinates:</span><span class="val">(${x}, ${y})</span></div>
          <div class="inspector-row"><span class="label">Status:</span><span class="val text-success">Clear Corridor</span></div>
        </div>
      `;
    }
  },

  // Inventory Table view
  renderInventoryTable() {
    const tableBody = document.getElementById("inventory-table-body");
    if (!tableBody) return;

    const query = document.getElementById("inventory-search").value.toLowerCase();
    const categoryFilter = document.getElementById("inventory-filter-category").value;
    const stockFilter = document.getElementById("inventory-filter-stock").value;

    let items = Inventory.getAll();

    // Apply Search
    if (query) {
      items = items.filter(item => 
        item.name.toLowerCase().includes(query) || 
        item.sku.toLowerCase().includes(query) ||
        item.category.toLowerCase().includes(query)
      );
    }

    // Apply Category Filter
    if (categoryFilter !== "all") {
      items = items.filter(item => item.category === categoryFilter);
    }

    // Apply Stock Filter
    if (stockFilter === "low") {
      items = items.filter(item => item.qty < 15 && item.qty > 0);
    } else if (stockFilter === "out") {
      items = items.filter(item => item.qty === 0);
    } else if (stockFilter === "healthy") {
      items = items.filter(item => item.qty >= 15);
    }

    tableBody.innerHTML = "";

    if (items.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="8" class="text-center" style="padding: 40px; color: var(--color-text-muted);">No inventory matching criteria found.</td></tr>`;
      return;
    }

    items.forEach(item => {
      const pct = (item.qty / item.capacity) * 100;
      let statusTag = '<span class="stock-status-tag healthy">Healthy</span>';
      let meterColor = "var(--color-success)";

      if (item.qty === 0) {
        statusTag = '<span class="stock-status-tag out">OOS</span>';
        meterColor = "var(--color-danger)";
      } else if (item.qty < 15) {
        statusTag = '<span class="stock-status-tag low">Low Stock</span>';
        meterColor = "var(--color-warning)";
      }

      const row = document.createElement("tr");
      row.innerHTML = `
        <td style="font-weight: 700; color: var(--accent-cyan);">${item.sku}</td>
        <td style="font-weight: 500;">${item.name}</td>
        <td><span style="font-size: 0.75rem; text-transform: uppercase; color: var(--color-text-secondary);">${item.category}</span></td>
        <td>Aisle ${Math.ceil(item.gridX / 2)}, Bay ${item.gridY}</td>
        <td><strong style="font-size: 1rem;">${item.qty}</strong></td>
        <td style="color: var(--color-text-muted);">${item.capacity}</td>
        <td>
          <div class="stock-meter-container">
            <div class="stock-meter-text">${statusTag} (${item.qty}/${item.capacity})</div>
            <div class="inspector-progress-track">
              <div class="inspector-progress-fill" style="width: ${pct}%; background: ${meterColor};"></div>
            </div>
          </div>
        </td>
        <td>
          <button class="btn-sm" style="background-color: rgba(0, 242, 254, 0.08); color: var(--accent-cyan); border: 1px solid rgba(0,242,254,0.2);" onclick="Inventory.addStock('${item.sku}', 20)">+20 Restock</button>
        </td>
      `;
      tableBody.appendChild(row);
    });
  },

  // Order Pipeline view (Kanban cards)
  renderPipelineBoard() {
    const lanes = {
      created: document.getElementById("lane-created"),
      allocated: document.getElementById("lane-allocated"),
      picking: document.getElementById("lane-picking"),
      packing: document.getElementById("lane-packing"),
      qc: document.getElementById("lane-qc"),
      dispatched: document.getElementById("lane-dispatched")
    };

    // Verify lanes exist on DOM (user could be in other tabs)
    if (!lanes.created) return;

    // Clear lanes
    Object.keys(lanes).forEach(k => {
      lanes[k].innerHTML = "";
    });

    // Populate order cards
    Orders.queue.forEach(order => {
      const card = document.createElement("div");
      // Map exception stage holds to visual pipeline columns
      let targetLaneKey = order.stage;
      if (order.stage === "shortage_hold") targetLaneKey = "created";
      if (order.stage === "damaged_hold") targetLaneKey = "picking";
      if (order.stage === "qc_hold") targetLaneKey = "qc";

      card.className = `order-card priority-${order.priorityLabel.toLowerCase()}`;
      
      let itemsListHtml = order.items.map(i => `${i.qty}x ${i.sku}`).join(", ");
      if (itemsListHtml.length > 28) itemsListHtml = itemsListHtml.substring(0, 26) + "...";

      const elapsedSec = Math.floor((Date.now() - order.createdAt) / 1000);

      card.innerHTML = `
        <div class="order-card-header">
          <span class="order-id-label">${order.id}</span>
          <span class="order-priority-tag">${order.priorityLabel}</span>
        </div>
        <div class="order-card-body">
          <span class="order-customer-label">${order.customer}</span>
          <span class="order-items-list">${itemsListHtml}</span>
        </div>
        <div class="order-card-footer">
          <span class="order-timer">🕒 ${elapsedSec}s</span>
          ${order.pickerId ? `<span class="order-assigned-picker">${order.pickerId}</span>` : ""}
        </div>
      `;

      // Highlight hold status exceptions visual style
      if (order.stage.endsWith("_hold")) {
        card.style.border = "1.5px solid var(--color-danger)";
        card.style.boxShadow = "0 0 10px rgba(255, 75, 92, 0.25)";
        
        const alertLabel = document.createElement("span");
        alertLabel.className = "order-priority-tag animate-pulse";
        alertLabel.style.background = "var(--color-danger)";
        alertLabel.style.color = "#fff";
        alertLabel.style.display = "block";
        alertLabel.style.marginTop = "4px";
        alertLabel.style.textAlign = "center";
        alertLabel.textContent = "STALLED / HOLD";
        card.querySelector(".order-card-body").appendChild(alertLabel);
      }

      if (lanes[targetLaneKey]) {
        lanes[targetLaneKey].appendChild(card);
      }
    });

    // Update Stage Counts headers
    document.getElementById("count-stage-created").textContent = Orders.queue.filter(o => o.stage === "created" || o.stage === "shortage_hold").length;
    document.getElementById("count-stage-allocated").textContent = Orders.getOrdersByStage("allocated").length;
    document.getElementById("count-stage-picking").textContent = Orders.queue.filter(o => o.stage === "picking" || o.stage === "damaged_hold").length;
    document.getElementById("count-stage-packing").textContent = Orders.getOrdersByStage("packing").length;
    document.getElementById("count-stage-qc").textContent = Orders.queue.filter(o => o.stage === "qc" || o.stage === "qc_hold").length;
    document.getElementById("count-stage-dispatched").textContent = Orders.getOrdersByStage("dispatched").length;
  },

  // Overview Bottlenecks rendering
  renderBottlenecks() {
    const barsContainer = document.getElementById("bottleneck-bars-container");
    if (!barsContainer) return;

    const stats = Analytics.getBottleneckStats();
    
    barsContainer.innerHTML = `
      <div class="bar-group">
        <span class="bar-label">Allocation</span>
        <div class="bar-track"><div class="bar-fill" style="width: ${stats.allocation.percentage}%; background: ${stats.allocation.count > 3 ? "var(--color-danger)" : "var(--accent-cyan)"}"></div></div>
        <span class="bar-val">${stats.allocation.count} ord</span>
      </div>
      <div class="bar-group">
        <span class="bar-label">Picking Route</span>
        <div class="bar-track"><div class="bar-fill" style="width: ${stats.picking.percentage}%; background: ${stats.picking.count > 3 ? "var(--color-danger)" : "var(--color-warning)"}"></div></div>
        <span class="bar-val">${stats.picking.count} ord</span>
      </div>
      <div class="bar-group">
        <span class="bar-label">Packing Bay</span>
        <div class="bar-track"><div class="bar-fill" style="width: ${stats.packing.percentage}%;"></div></div>
        <span class="bar-val">${stats.packing.count} ord</span>
      </div>
      <div class="bar-group">
        <span class="bar-label">Quality Check</span>
        <div class="bar-track"><div class="bar-fill" style="width: ${stats.qc.percentage}%; background: ${stats.qc.count > 3 ? "var(--color-danger)" : "var(--color-info)"}"></div></div>
        <span class="bar-val">${stats.qc.count} ord</span>
      </div>
    `;
  },

  // Heatmap rendering
  renderHeatmap() {
    const container = document.getElementById("heatmap-analytics-grid");
    if (!container) return;
    container.innerHTML = "";

    for (let y = 0; y < Simulator.gridHeight; y++) {
      for (let x = 0; x < Simulator.gridWidth; x++) {
        const cell = document.createElement("div");
        const weightClass = Analytics.getHeatmapWeight(x, y);
        cell.className = `heatmap-cell ${weightClass}`;
        cell.title = `Visits: ${Analytics.heatmap[y][x]} times`;
        container.appendChild(cell);
      }
    }
  },

  // Analytics KPIs view
  renderAnalyticsKPIs() {
    const avgSpeed = document.getElementById("kpi-avg-speed");
    if (avgSpeed) avgSpeed.textContent = `${Analytics.avgCycleTime.toFixed(1)}s`;
    
    const qcRate = document.getElementById("kpi-qc-rate");
    if (qcRate) qcRate.textContent = `${Analytics.getQcPassRate().toFixed(1)}%`;
    
    const resolvedEx = document.getElementById("kpi-resolved-exceptions");
    if (resolvedEx) resolvedEx.textContent = Analytics.resolvedExceptions;

    const stockSaved = document.getElementById("kpi-stock-saved");
    if (stockSaved) stockSaved.textContent = Orders.stockSavedCount;
  },

  /* ==========================================================================
     DECISION ROOM: EXCEPTION RESOLUTION CONTROLLER
     ========================================================================== */
  onExceptionRaised(order) {
    const modal = document.getElementById("exception-modal");
    const title = document.getElementById("modal-exception-title");
    const body = document.getElementById("modal-exception-body");
    const actions = document.getElementById("modal-exception-actions");

    if (!modal || !order.exceptionFlag) return;

    const ex = order.exceptionFlag;

    if (ex.type === "shortage") {
      title.textContent = `Shortage Exception: Order ${order.id}`;
      
      const missingQty = ex.needed - ex.available;
      const itemInfo = Inventory.getBySku(ex.sku);

      body.innerHTML = `
        <p>Order <strong>${order.id}</strong> (Client: <strong>${order.customer}</strong>, Priority Score: <strong>${order.priority.toFixed(0)}</strong>) requires <strong>${ex.needed} units</strong> of <strong>${itemInfo.name}</strong>, but only <strong>${ex.available} units</strong> are available in stock.</p>
        <p class="text-warning">⚠️ The smart reallocation protocol failed to locate standard allocated candidates of lower priority to steal stock from.</p>
        
        <div class="modal-comparison-grid">
          <div>
            <div class="comparison-option-title" style="color: var(--accent-cyan);">Option A: Ship Partial Inventory</div>
            <div class="comparison-option-desc">Ship the available ${ex.available} units now. The remaining ${missingQty} units will be placed on backorder (fulfillment status will proceed).</div>
          </div>
          <div style="margin-top: 8px;">
            <div class="comparison-option-title" style="color: var(--color-success);">Option B: Trigger Emergency Restock</div>
            <div class="comparison-option-desc">Purchase urgent items from an immediate local courier. Instantly fills the rack capacity to maximum. Resolves shortage immediately.</div>
          </div>
        </div>
      `;

      actions.innerHTML = `
        <button class="btn-secondary" onclick="window.resolveException('allocate_partial')">A: Ship Partial & Backorder</button>
        <button class="btn-primary" onclick="window.resolveException('emergency_restock')">B: Emergency Restock All</button>
        <button class="btn-danger" style="margin-left: auto;" onclick="window.resolveException('cancel_order')">Cancel Order</button>
      `;
    } 
    else if (ex.type === "damaged") {
      title.textContent = `Damaged Item Exception: Order ${order.id}`;
      const itemInfo = Inventory.getBySku(ex.sku);
      
      body.innerHTML = `
        <p>While picking stock for order <strong>${order.id}</strong>, robot picker agent <strong>${ex.pickerId}</strong> flagged that the unit of <strong>${itemInfo.name}</strong> on row shelf location (${itemInfo.gridX}, ${itemInfo.gridY}) is damaged/unusable.</p>
        
        <div class="modal-comparison-grid">
          <div>
            <div class="comparison-option-title" style="color: var(--accent-cyan);">Option A: Source from Alternative Location</div>
            <div class="comparison-option-desc">Picker will route to a backup rack storage coordinate cell. Deducts 1 fresh stock unit and updates picker route path dynamically.</div>
          </div>
          <div style="margin-top: 8px;">
            <div class="comparison-option-title" style="color: var(--color-warning);">Option B: Substitute Compatible SKU</div>
            <div class="comparison-option-desc">Swap item on the order details to a compatible alternative SKU from the same category that is in healthy stock.</div>
          </div>
        </div>
      `;

      actions.innerHTML = `
        <button class="btn-primary" onclick="window.resolveException('alternative_bin')">A: Pick Alternate Location</button>
        <button class="btn-secondary" onclick="window.resolveException('swap_substitute')">B: Swap with Similar Item</button>
        <button class="btn-danger" style="margin-left: auto;" onclick="window.resolveException('cancel_order')">Cancel Order</button>
      `;
    } 
    else if (ex.type === "qc_failure") {
      title.textContent = `Quality Failure Exception: Order ${order.id}`;
      
      body.innerHTML = `
        <p>Order <strong>${order.id}</strong> failed final visual and barcode scanning validation checks due to a cosmetic shelf-wear defect.</p>
        
        <div class="modal-comparison-grid">
          <div>
            <div class="comparison-option-title" style="color: var(--accent-cyan);">Option A: Apply Discount & Ship</div>
            <div class="comparison-option-desc">Override QC check. Ship the item with a 20% discount coupon issued to the customer. Keeps speed high.</div>
          </div>
          <div style="margin-top: 8px;">
            <div class="comparison-option-title" style="color: var(--color-warning);">Option B: Reject & Re-pick</div>
            <div class="comparison-option-desc">Send the order back to the Picking stage. A fresh item will be gathered from shelves, and the damaged item is recycled.</div>
          </div>
        </div>
      `;

      actions.innerHTML = `
        <button class="btn-primary" onclick="window.resolveException('discount_ship')">A: Ship with 20% Discount</button>
        <button class="btn-secondary" onclick="window.resolveException('re_pick')">B: Reject & Re-pick Fresh</button>
        <button class="btn-danger" style="margin-left: auto;" onclick="window.resolveException('cancel_order')">Cancel Order</button>
      `;
    }

    // Show Modal
    modal.classList.add("active");
  },

  handleExceptionResolution(decision) {
    const order = this.activeExceptionOrder;
    if (!order) return;

    const ex = order.exceptionFlag;
    let logMessage = "";
    
    // Resolve Decision State Transitions
    if (decision === "allocate_partial") {
      // Ship whatever is available in stock, rest to backorder
      order.items.forEach(item => {
        const stock = Inventory.getBySku(item.sku);
        if (stock) {
          const shipped = Math.min(item.qty, stock.qty);
          Inventory.deductStock(item.sku, shipped);
        }
      });
      order.partialAllocated = true;
      order.stage = "allocated";
      order.exceptionFlag = null;
      logMessage = `Decision resolved: Shipped Order ${order.id} partially. Remaining backordered.`;
    } 
    else if (decision === "emergency_restock") {
      // Instantly restock the missing SKU to capacity, then complete allocation
      const stock = Inventory.getBySku(ex.sku);
      if (stock) {
        Inventory.addStock(ex.sku, stock.capacity);
      }
      
      // Retry allocation
      order.items.forEach(item => {
        Inventory.deductStock(item.sku, item.qty);
      });
      order.stage = "allocated";
      order.exceptionFlag = null;
      logMessage = `Decision resolved: Emergency restock triggered for SKU ${ex.sku}. Order ${order.id} fully allocated.`;
    } 
    else if (decision === "alternative_bin") {
      // We simulate picking from a different aisle rack (essentially, let picker proceed from current cell)
      // Deduct 1 stock (which simulates finding another unit elsewhere)
      Inventory.deductStock(ex.sku, 1);
      order.stage = "picking";
      order.exceptionFlag = null;
      logMessage = `Decision resolved: Picker routed to alternative shelf location for SKU ${ex.sku}. Route resuming.`;
    } 
    else if (decision === "swap_substitute") {
      // Substitute with a compatible item
      // Find similar category item from catalog
      const originalItem = order.items.find(i => i.sku === ex.sku);
      const replacementSku = ex.sku.startsWith("EL") ? "EL-101" : ex.sku.startsWith("AP") ? "AP-201" : ex.sku.startsWith("MD") ? "MD-303" : "FD-401";
      
      if (originalItem && replacementSku !== ex.sku) {
        const originalName = originalItem.name;
        const replacementItem = Inventory.getBySku(replacementSku);
        
        originalItem.sku = replacementSku;
        originalItem.name = replacementItem.name;
        
        Inventory.deductStock(replacementSku, originalItem.qty);
        logMessage = `Decision resolved: Substituted damaged item ${originalName} with ${replacementItem.name}.`;
      } else {
        // Fallback if no substitute or replacement matches original
        Inventory.addStock(ex.sku, 10);
        logMessage = `Decision resolved: Inventory inventory re-sourced. Picker route resumed.`;
      }
      order.stage = "picking";
      order.exceptionFlag = null;
    } 
    else if (decision === "discount_ship") {
      // Ship item with discount
      Analytics.qcSuccessCount++; // QC override
      order.exceptionFlag = null;
      Simulator.dispatchOrder(order);
      logMessage = `Decision resolved: QC exception bypassed with 20% discount coupon. Order ${order.id} shipped.`;
    } 
    else if (decision === "re_pick") {
      // Reset stages back to picking, dispatch fresh pick route
      Analytics.qcFailureCount++;
      order.stage = "allocated";
      order.exceptionFlag = null;
      logMessage = `Decision resolved: QC failed item recycled. Re-routing picker for fresh unit pick for Order ${order.id}.`;
    } 
    else if (decision === "cancel_order") {
      // Remove order from queue completely
      const idx = Orders.queue.findIndex(o => o.id === order.id);
      if (idx !== -1) {
        Orders.queue.splice(idx, 1);
      }
      
      // If a picker was assigned, release them
      if (ex.pickerId) {
        const picker = Simulator.pickers.find(p => p.id === ex.pickerId);
        if (picker) {
          picker.state = "idle";
          picker.assignedOrderId = null;
          picker.path = [];
          picker.pathIndex = 0;
        }
      }
      
      logMessage = `Decision resolved: Order ${order.id} has been CANCELLED and refunded.`;
    }

    // Register analytics count
    Analytics.resolvedExceptions++;
    Analytics.logOperation(logMessage, "success");

    // Close Modal and Resume Simulation
    document.getElementById("exception-modal").classList.remove("active");
    this.activeExceptionOrder = null;
    Simulator.activeExceptionOrder = null;
    
    // Auto-resume speed at 1x
    Simulator.setSpeed(1);

    // Refresh views
    this.onSimTick();
  }
};
