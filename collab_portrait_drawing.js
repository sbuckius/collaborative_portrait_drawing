/***** Firebase setup (compat) *****/
const firebaseConfig = {
  // ← use your own values if different
  apiKey: "AIzaSyCQC0SJrSYmt8_pgAu6d56XFB0GnDoAu2c",
  authDomain: "collaborativeportraitdrawing.firebaseapp.com",
  databaseURL: "https://collaborativeportraitdrawing-default-rtdb.firebaseio.com", // REQUIRED
  projectId: "collaborativeportraitdrawing",
  storageBucket: "collaborativeportraitdrawing.appspot.com",
  messagingSenderId: "752072712547",
  appId: "1:752072712547:web:3302af6b41a93e59f8b356",
  measurementId: "G-57VNEXBJJM"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// Single shared canvas for everyone (no rooms)
const actionsRef = db.ref("canvas/actions");

/***** Tools & UI *****/
const TOOL_LIST = [
  { id: "rect",     label: "Rect" },
  { id: "square",   label: "Square" },
  { id: "ellipse",  label: "Ellipse" },
  { id: "circle",   label: "Circle" },
  { id: "line",     label: "Line" },
  { id: "arc",      label: "Arc" },
  { id: "triangle", label: "Triangle" },
  { id: "quad",     label: "Quad" },
  { id: "bezier",   label: "Bezier" },
  { id: "curve",    label: "curveVertex" }
];

const toolGrid      = document.getElementById("toolGrid");
const fillColorEl   = document.getElementById("fillColor");
const strokeColorEl = document.getElementById("strokeColor");
const strokeWeightEl= document.getElementById("strokeWeight");
const fillToggleEl  = document.getElementById("fillToggle");
const strokeToggleEl= document.getElementById("strokeToggle");
const arcStartEl    = document.getElementById("arcStart");
const arcStopEl     = document.getElementById("arcStop");

let currentTool = "rect";
function rebuildToolGrid() {
  toolGrid.innerHTML = "";
  TOOL_LIST.forEach(t => {
    const b = document.createElement("button");
    b.className = "tool" + (currentTool === t.id ? " active" : "");
    b.textContent = t.label;
    b.onclick = () => { currentTool = t.id; rebuildToolGrid(); inProgress = null; };
    toolGrid.appendChild(b);
  });
}
rebuildToolGrid();

/***** Drawing state *****/
// Separate remote vs local fallback to avoid disappearing shapes
let remoteActions = [];        // from Firebase
let localActions  = [];        // locally kept if Firebase push fails
let hadAnyRemote  = false;     // to avoid premature clears
let inProgress    = null;      // current live preview
let staticLayer;               // p5.Graphics persistent layer

function toNumber(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }
function currentStyle(){
  return {
    fill:   (fillToggleEl.value === "on") ? fillColorEl.value   : null,
    stroke: (strokeToggleEl.value === "on") ? strokeColorEl.value : null,
    weight: toNumber(strokeWeightEl.value) || 0
  };
}
function deg2rad(d){ return (d * Math.PI) / 180; }

/***** Firebase listeners *****/
actionsRef.orderByChild("ts").on("child_added", snap => {
  hadAnyRemote = true;
  remoteActions.push({ key: snap.key, ...snap.val() });
  renderStaticLayer();
});
actionsRef.on("child_removed", snap => {
  remoteActions = remoteActions.filter(a => a.key !== snap.key);
  renderStaticLayer();
});
// Only clear remote/local when the node truly becomes empty *after* we've seen data.
actionsRef.on("value", snap => {
  if (!snap.exists() && hadAnyRemote) {
    remoteActions = [];
    localActions  = [];
    renderStaticLayer();
  }
});

/***** Commit action (with bulletproof local fallback) *****/
function commitAction(action) {
  actionsRef.push({ ...action, ts: Date.now() }, err => {
    if (err) {
      console.warn("Firebase push failed; keeping locally:", err?.message || err);
      localActions.push(action);
      renderStaticLayer();
    }
  });
}

/***** Reset button *****/
document.getElementById("resetBtn").addEventListener("click", async () => {
  if (!confirm("Reset the canvas for everyone?")) return;
  await actionsRef.set(null);
  localActions = [];
  renderStaticLayer();
});

/***** Save button *****/
document.getElementById("saveBtn").addEventListener("click", () => {
  try { window.saveCanvas("collab-drawing", "png"); }
  catch (e) { alert("Press ⌘/Ctrl+S on the canvas to save."); }
});

/***** p5 sketch *****/
const CANVAS_W = 1200, CANVAS_H = 800;
const sketch = (p) => {
  p.setup = () => {
    const host = document.getElementById("canvas-container");
    const w = Math.min(CANVAS_W, (host.clientWidth || CANVAS_W) - 20);
    const c = p.createCanvas(w, CANVAS_H);
    c.parent(host);
    p.pixelDensity(2);
    staticLayer = p.createGraphics(p.width, p.height);
    staticLayer.background("#ffffff"); // white canvas base
    p.noLoop();
  };

  p.windowResized = () => {
    const host = document.getElementById("canvas-container");
    const w = Math.min(CANVAS_W, (host.clientWidth || CANVAS_W) - 20);
    p.resizeCanvas(w, CANVAS_H);
    staticLayer = p.createGraphics(p.width, p.height);
    staticLayer.background("#ffffff");
    renderStaticLayer();
    p.redraw();
  };

  p.draw = () => {
    p.background("#ffffff");
    p.image(staticLayer, 0, 0);
    if (inProgress) drawOne(p, inProgress, true);
  };

  p.mousePressed = () => {
    if (!withinCanvas(p)) return;

    // MULTI-POINT tools use mousePressed for each vertex (no mouseClicked confusion).
    if (["triangle","quad","bezier"].includes(currentTool)) {
      if (!inProgress) {
        inProgress = { type: currentTool, style: currentStyle(), points: [] };
      }
      inProgress.points.push({ x: p.mouseX, y: p.mouseY });

      const n = inProgress.points.length;
      if (currentTool === "triangle" && n === 3) {
        const [a,b,c] = inProgress.points;
        commitAction(serialize({ type:"triangle", style: inProgress.style, params:[a.x,a.y,b.x,b.y,c.x,c.y] }));
        inProgress = null; p.redraw();
      }
      if (currentTool === "quad" && n === 4) {
        const [a,b,c,d] = inProgress.points;
        commitAction(serialize({ type:"quad", style: inProgress.style, params:[a.x,a.y,b.x,b.y,c.x,c.y,d.x,d.y] }));
        inProgress = null; p.redraw();
      }
      if (currentTool === "bezier" && n === 4) {
        const [a,c1,c2,b] = inProgress.points; // anchor1, control1, control2, anchor2
        commitAction(serialize({ type:"bezier", style: visibleStrokeStyleFor("bezier", inProgress.style), params:[a.x,a.y,c1.x,c1.y,c2.x,c2.y,b.x,b.y] }));
        inProgress = null; p.redraw();
      }
      return;
    }

    // DRAG tools
    const style = currentStyle();
    const start = { x: p.mouseX, y: p.mouseY };
    inProgress = { type: currentTool, style, params: [start.x, start.y, start.x, start.y], points: [] };
    p.redraw();
  };

  p.mouseDragged = () => {
    if (!inProgress || !withinCanvas(p)) return;
    const end = { x: p.mouseX, y: p.mouseY };
    switch (inProgress.type) {
      case "curve":
        inProgress.points.push({ x: end.x, y: end.y });
        break;
      case "rect": case "square": case "ellipse": case "circle": case "arc": case "line":
        const [x1,y1] = [inProgress.params[0], inProgress.params[1]];
        inProgress.params = [x1, y1, end.x, end.y];
        break;
    }
    p.redraw();
  };

  p.mouseReleased = () => {
    if (!inProgress) return;
    if (["triangle","quad","bezier"].includes(inProgress.type)) return; // handled in mousePressed
    if (inProgress.type === "curve") {
      if ((inProgress.points || []).length > 2) {
        // Ensure visible stroke for freehand curves
        inProgress.style = visibleStrokeStyleFor("curve", inProgress.style);
        commitAction(serialize(inProgress));
      }
    } else {
      if (inProgress.type === "line") {
        inProgress.style = visibleStrokeStyleFor("line", inProgress.style);
      }
      commitAction(serialize(inProgress));
    }
    inProgress = null; p.redraw();
  };

  function withinCanvas(p){
    return p.mouseX >= 0 && p.mouseX <= p.width && p.mouseY >= 0 && p.mouseY <= p.height;
  }
};
new p5(sketch);

/***** Drawing helpers *****/
function visibleStrokeStyleFor(type, style) {
  // Make sure stroke-only shapes never vanish on white canvas
  if (["line", "bezier", "curve"].includes(type)) {
    const weight = style.weight ?? 0;
    return {
      ...style,
      stroke: style.stroke || "#111827",
      weight: Math.max(1, weight || 1)
    };
  }
  return style;
}

function applyStyle(g, style, isPreview=false){
  const s = style;
  if (s.fill) g.fill(s.fill); else g.noFill();
  if (s.stroke && (s.weight ?? 0) > 0) { g.stroke(s.stroke); g.strokeWeight(s.weight); } else g.noStroke();
  if (isPreview) { g.push(); g.drawingContext.setLineDash([6,6]); g.pop(); }
}

function drawOne(g, action, isPreview=false){
  const a = action.params || [];
  const type = action.type;
  const styled = visibleStrokeStyleFor(type, action.style);
  applyStyle(g, styled, isPreview);

  switch (type) {
    case "rect": {
      const [x1,y1,x2,y2]=a; g.rectMode(g.CORNERS); g.rect(x1,y1,x2,y2); break;
    }
    case "square": {
      const [x1,y1,x2,y2]=a; const s=Math.max(Math.abs(x2-x1),Math.abs(y2-y1));
      const x=x2>=x1?x1:x1-s, y=y2>=y1?y1:y1-s; g.rectMode(g.CORNER); g.square(x,y,s); break;
    }
    case "ellipse": {
      const [x1,y1,x2,y2]=a; g.ellipseMode(g.CORNERS); g.ellipse(x1,y1,x2,y2); break;
    }
    case "circle": {
      const [x1,y1,x2,y2]=a; const d=Math.max(Math.abs(x2-x1),Math.abs(y2-y1));
      const x=x2>=x1?x1:x1-d, y=y2>=y1?y1:y1-d; g.circle(x+d/2,y+d/2,d); break;
    }
    case "line": {
      const [x1,y1,x2,y2]=a; g.line(x1,y1,x2,y2); break;
    }
    case "arc": {
      // Draw arc using center mode for reliability
      const [x1,y1,x2,y2]=a;
      const cx=(x1+x2)/2, cy=(y1+y2)/2, w=Math.abs(x2-x1), h=Math.abs(y2-y1);
      const start=deg2rad(toNumber(arcStartEl.value)), stop=deg2rad(toNumber(arcStopEl.value));
      g.ellipseMode(g.CENTER); g.arc(cx,cy,w,h,start,stop);
      break;
    }
    case "triangle": {
      const [x1,y1,x2,y2,x3,y3]=a; if(a.length===6) g.triangle(x1,y1,x2,y2,x3,y3); break;
    }
    case "quad": {
      const [x1,y1,x2,y2,x3,y3,x4,y4]=a; if(a.length===8) g.quad(x1,y1,x2,y2,x3,y3,x4,y4); break;
    }
    case "bezier": {
      const [ax,ay,c1x,c1y,c2x,c2y,bx,by]=a; if(a.length===8) g.bezier(ax,ay,c1x,c1y,c2x,c2y,bx,by); break;
    }
    case "curve": {
      const pts = action.points || []; if (pts.length < 2) break;
      g.noFill(); g.beginShape(); pts.forEach(pt => g.curveVertex(pt.x, pt.y)); g.endShape(); break;
    }
  }
}

function renderStaticLayer(){
  if (!staticLayer) return;
  staticLayer.clear();
  staticLayer.background("#ffffff");
  staticLayer.push(); staticLayer.strokeJoin(staticLayer.ROUND); staticLayer.strokeCap(staticLayer.ROUND);
  // Draw remote first, then local fallback on top
  remoteActions.forEach(a => drawOne(staticLayer, a));
  localActions.forEach(a  => drawOne(staticLayer, a));
  staticLayer.pop();
  const c = document.querySelector("canvas");
  if (c) { c.style.outline = "1px solid transparent"; requestAnimationFrame(() => c.style.outline = ""); }
}

function serialize(ip){
  const base = { type: ip.type, style: ip.style };
  if (ip.type === "curve") return { ...base, points: (ip.points||[]).map(({x,y}) => ({ x:Math.round(x), y:Math.round(y) })) };
  return { ...base, params: (ip.params||[]).map(n => Math.round(n)) };
}
