/* ==========================================================================
   LOGIFORCE AI - INVENTORY MANAGER
   ========================================================================== */

const Inventory = {
  items: {},

  init() {
    // Initial inventory list with coordinates mapping to our grid (Rows 0-9, Cols 0-11)
    // Grid Setup:
    // Rows 1-8 are racking areas.
    // Cols 1,2: Electronics | Cols 4,5: Apparel | Cols 7,8: Medical | Cols 10,11: Food
    // Row 0: Corridor
    // Row 9: packing (col 3,4) & dispatch (col 7,8)
    const initialSkus = [
      { sku: "EL-101", name: "OptiCore Microcontroller", category: "electronics", qty: 25, capacity: 50, gridX: 1, gridY: 1 },
      { sku: "EL-102", name: "Zenith HDMI Receiver", category: "electronics", qty: 6, capacity: 40, gridX: 1, gridY: 3 },
      { sku: "EL-103", name: "Nvidia RTX SuperChip", category: "electronics", qty: 12, capacity: 30, gridX: 2, gridY: 5 },
      { sku: "EL-104", name: "Quantum OLED Panel", category: "electronics", qty: 15, capacity: 30, gridX: 2, gridY: 7 },
      
      { sku: "AP-201", name: "HyperWeave Carbon Jacket", category: "apparel", qty: 35, capacity: 60, gridX: 4, gridY: 1 },
      { sku: "AP-202", name: "AeroRunning Sport Sneakers", category: "apparel", qty: 10, capacity: 45, gridX: 4, gridY: 4 },
      { sku: "AP-203", name: "FlexiFit Thermal Pants", category: "apparel", qty: 45, capacity: 50, gridX: 5, gridY: 2 },
      { sku: "AP-204", name: "NanoShield Windbreaker", category: "apparel", qty: 4, capacity: 25, gridX: 5, gridY: 6 },
      
      { sku: "MD-301", name: "SurgiShield Latex Gloves", category: "medical", qty: 80, capacity: 100, gridX: 7, gridY: 2 },
      { sku: "MD-302", name: "MediSterile Bandages Set", category: "medical", qty: 5, capacity: 50, gridX: 7, gridY: 5 },
      { sku: "MD-303", name: "AeroPump Digital Inhaler", category: "medical", qty: 20, capacity: 40, gridX: 8, gridY: 3 },
      { sku: "MD-304", name: "GlucoTrak Blood Monitor", category: "medical", qty: 11, capacity: 30, gridX: 8, gridY: 7 },
      
      { sku: "FD-401", name: "VitaGrain Energy Bar 24x", category: "food", qty: 70, capacity: 80, gridX: 10, gridY: 1 },
      { sku: "FD-402", name: "Organic Almond Milk 1L", category: "food", qty: 14, capacity: 40, gridX: 10, gridY: 4 },
      { sku: "FD-403", name: "AeroSoy Protein Blend", category: "food", qty: 6, capacity: 35, gridX: 11, gridY: 3 },
      { sku: "FD-404", name: "TerraBeans Espresso Roast", category: "food", qty: 32, capacity: 50, gridX: 11, gridY: 6 }
    ];

    initialSkus.forEach(item => {
      this.items[item.sku] = { ...item };
    });
  },

  getAll() {
    return Object.values(this.items);
  },

  getBySku(sku) {
    return this.items[sku] || null;
  },

  deductStock(sku, quantity) {
    if (this.items[sku]) {
      this.items[sku].qty = Math.max(0, this.items[sku].qty - quantity);
      this.triggerUpdateEvents(sku);
      return true;
    }
    return false;
  },

  addStock(sku, quantity) {
    if (this.items[sku]) {
      this.items[sku].qty = Math.min(this.items[sku].capacity, this.items[sku].qty + quantity);
      this.triggerUpdateEvents(sku);
      return true;
    }
    return false;
  },

  restockAll() {
    Object.keys(this.items).forEach(sku => {
      this.items[sku].qty = this.items[sku].capacity;
      this.triggerUpdateEvents(sku);
    });
  },

  getLowStockItems() {
    return Object.values(this.items).filter(item => item.qty < 15);
  },

  // Returns info about a grid cell to assist the UI inspector and pathfinder
  getCellInfo(x, y) {
    // Check if it matches any rack location
    const matchedItem = Object.values(this.items).find(item => item.gridX === x && item.gridY === y);
    if (matchedItem) {
      return { type: "rack", item: matchedItem, name: matchedItem.name, category: matchedItem.category };
    }

    // Check stations
    if (y === 9 && (x === 3 || x === 4)) {
      return { type: "packing", name: "Packing Bay B1" };
    }
    if (y === 9 && (x === 7 || x === 8)) {
      return { type: "dispatch", name: "Dispatch Dock D1" };
    }
    if (y === 0 && (x === 5 || x === 6)) {
      return { type: "hub", name: "Picker Charging Hub" };
    }

    // Corridor
    return { type: "corridor", name: "Transit Lane" };
  },

  triggerUpdateEvents(sku) {
    // Dispatch a custom event to notify other scripts that stock level changed
    const event = new CustomEvent("stockUpdated", { detail: { sku: sku, item: this.items[sku] } });
    window.dispatchEvent(event);
  }
};
