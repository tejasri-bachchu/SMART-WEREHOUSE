/* ==========================================================================
   LOGIFORCE AI - ANALYTICS ENGINE
   ========================================================================== */

const Analytics = {
  logs: [],
  cycleTimes: [],
  avgCycleTime: 0,
  qcSuccessCount: 0,
  qcFailureCount: 0,
  resolvedExceptions: 0,
  
  // Heatmap tracking grid (12 cols x 10 rows)
  heatmap: Array(10).fill(null).map(() => Array(12).fill(0)),
  maxHeatVal: 1,

  logOperation(message, type = "info") {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = { time: timestamp, text: message, type: type };
    this.logs.unshift(logEntry); // Add to beginning of log list
    if (this.logs.length > 50) this.logs.pop(); // Keep size manageable
    
    // Trigger custom event
    const event = new CustomEvent("logAdded", { detail: logEntry });
    window.dispatchEvent(event);
  },

  incrementHeatmap(x, y) {
    if (x >= 0 && x < 12 && y >= 0 && y < 10) {
      this.heatmap[y][x]++;
      if (this.heatmap[y][x] > this.maxHeatVal) {
        this.maxHeatVal = this.heatmap[y][x];
      }
    }
  },

  recordCycleTime(seconds) {
    this.cycleTimes.push(seconds);
    const sum = this.cycleTimes.reduce((a, b) => a + b, 0);
    this.avgCycleTime = sum / this.cycleTimes.length;
  },

  getQcPassRate() {
    const totalQc = this.qcSuccessCount + this.qcFailureCount;
    if (totalQc === 0) return 100.0;
    return (this.qcSuccessCount / totalQc) * 100;
  },

  // Calculate congestion at each pipeline stage
  getBottleneckStats() {
    const stages = {
      allocation: Orders.getOrdersByStage("created").length + Orders.getOrdersByStage("shortage_hold").length,
      picking: Orders.getOrdersByStage("picking").length + Orders.getOrdersByStage("damaged_hold").length,
      packing: Orders.getOrdersByStage("packing").length,
      qc: Orders.getOrdersByStage("qc").length + Orders.getOrdersByStage("qc_hold").length,
      dispatched: Orders.getOrdersByStage("dispatched").length
    };

    const maxCount = Math.max(1, ...Object.values(stages));
    
    return {
      allocation: { count: stages.allocation, percentage: (stages.allocation / maxCount) * 100 },
      picking: { count: stages.picking, percentage: (stages.picking / maxCount) * 100 },
      packing: { count: stages.packing, percentage: (stages.packing / maxCount) * 100 },
      qc: { count: stages.qc, percentage: (stages.qc / maxCount) * 100 },
      dispatched: { count: stages.dispatched, percentage: (stages.dispatched / maxCount) * 100 }
    };
  },

  getHeatmapWeight(x, y) {
    const count = this.heatmap[y][x];
    if (count === 0) return "heat-0";
    
    const ratio = count / this.maxHeatVal;
    if (ratio < 0.15) return "heat-1";
    if (ratio < 0.35) return "heat-2";
    if (ratio < 0.60) return "heat-3";
    if (ratio < 0.80) return "heat-4";
    if (ratio < 0.95) return "heat-5";
    return "heat-max";
  },

  // Render SVG Chart timeline path based on recent orders dispatched over simulated time
  updateTimelineChart() {
    const svgPath = document.getElementById("timeline-path");
    if (!svgPath) return;

    const pointsCount = Math.min(10, this.cycleTimes.length);
    if (pointsCount < 2) {
      // Draw static flat line if insufficient data points
      svgPath.setAttribute("d", "M 40 170 L 480 170");
      return;
    }

    const startX = 40;
    const endX = 480;
    const chartHeight = 150; // height inside container
    const chartBaseY = 170; // baseline Y
    
    const sliceX = (endX - startX) / (pointsCount - 1);
    const recentTimes = this.cycleTimes.slice(-pointsCount);
    const maxVal = Math.max(1, ...recentTimes);

    let pathD = `M ${startX} ${chartBaseY - (recentTimes[0] / maxVal) * chartHeight}`;
    
    for (let i = 1; i < pointsCount; i++) {
      const x = startX + i * sliceX;
      const y = chartBaseY - (recentTimes[i] / maxVal) * chartHeight;
      pathD += ` L ${x} ${y}`;
    }

    svgPath.setAttribute("d", pathD);
  }
};
