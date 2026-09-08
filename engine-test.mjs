/** Isolated P0 engine test harness. Run: node engine-test.mjs */
let model = { periods: ["P1"], ov: {}, vars: [] };

function compile(expr){
  const toks=(String(expr).match(/[A-Za-z_][A-Za-z0-9_]*|\d+\.?\d*|[()+\-*/]/g))||[];
  const out=[],ops=[],prec={'+':1,'-':1,'*':2,'/':2};
  for(const t of toks){
    if(/^[\d.]/.test(t)) out.push({n:+t});
    else if(/^[A-Za-z_]/.test(t)) out.push({v:t});
    else if(t==='(') ops.push(t);
    else if(t===')'){ while(ops.length&&ops[ops.length-1]!=='(') out.push({op:ops.pop()}); ops.pop(); }
    else { while(ops.length&&prec[ops[ops.length-1]]>=prec[t]) out.push({op:ops.pop()}); ops.push(t); }
  }
  while(ops.length) out.push({op:ops.pop()});
  const deps=[...new Set(out.filter(x=>'v' in x).map(x=>x.v))];
  return {rpn:out,deps};
}
/* Fixed-scale decimal arithmetic (integer micros at 1e8) for deterministic + - * / */
const NN_SCALE=1e8;
function nnToMicro(n){ const x=Number(n); return Number.isFinite(x)?Math.round(x*NN_SCALE):NaN; }
function nnFromMicro(m){ return Number.isFinite(m)?m/NN_SCALE:NaN; }
function evalRPN(rpn,scope){
  const st=[];
  for(const x of rpn){
    if('n' in x) st.push(nnToMicro(x.n));
    else if('v' in x){
      const raw=scope[x.v.toLowerCase()];
      if(raw===undefined || raw===null || (typeof raw==='number' && Number.isNaN(raw))) st.push(NaN);
      else st.push(nnToMicro(Number(raw)));
    }
    else {
      const b=st.pop(), a=st.pop();
      if(!Number.isFinite(a) || !Number.isFinite(b)){ st.push(NaN); continue; }
      let r;
      if(x.op==='+') r=a+b;
      else if(x.op==='-') r=a-b;
      else if(x.op==='*') r=Math.round((a*b)/NN_SCALE);
      else if(x.op==='/'){
        if(b===0) throw new Error('Division by zero');
        r=Math.round((a*NN_SCALE)/b);
      } else r=NaN;
      st.push(r);
    }
  }
  if(!st.length) return 0;
  const top=st[st.length-1];
  return Number.isFinite(top)?nnFromMicro(top):NaN;
}

function P(){ return model.periods.length; }
function vget(k){ return model.vars.find(v=>v.key===k); }
function inputs(){ return model.vars.filter(v=>v.kind==="input"); }
function formulas(){ return model.vars.filter(v=>v.kind==="formula"); }
function outputs(){ return model.vars.filter(v=>v.kind==="output"); }
function recompileAll(){ formulas().forEach(v=>{ try{ v.compiled=compile(v.expr); v.err=""; }catch(e){ v.compiled={rpn:[],deps:[]}; v.err=String(e);} }); }

/* baseline level of an input over time: a RAMP (start→target over N months) OR
   base + forward-filled step changes. */
function levelArray(v){
  const n=P();
  if(v.ramp && v.ramp.on){
    const r=v.ramp, s=Math.max(0,Math.min(n-1,r.start|0)), m=Math.max(1,r.months|0),
      from=(r.from!=null?r.from:0), to=(r.to!=null?r.to:v.base);
    const arr=new Array(n);
    for(let p=0;p<n;p++){ arr[p]= p<s?from : p>=s+m?to : from+(to-from)*((p-s+1)/m); }
    return arr;
  }
  const arr=new Array(n).fill(v.base);
  (v.steps||[]).slice().sort((a,b)=>a.from-b.from).forEach(st=>{ for(let p=st.from;p<n;p++) arr[p]=st.value; });
  return arr;
}
/* SEASONALITY: a per-period multiplier around the level (default 1.0). value = level × phase. */
function schedule(v){
  const n=P();
  let arr=levelArray(v);
  if(v.phase && v.phase.length){ arr=arr.map((x,p)=> x*(v.phase[p]!=null?v.phase[p]:1)); }
  return arr;
}
function hasShape(v){ return (v.ramp&&v.ramp.on) || (v.phase&&v.phase.some(x=>Math.abs((x==null?1:x)-1)>1e-6)); }
/* scenario overrides are ANCHORS: model.ov[key][period] = value you dragged that month to.
   An anchor carries FORWARD — every later month keeps the baseline's own month-to-month
   movement but re-based to the dragged level (additive shift):
     scenario[q] = anchorValue + (baseline[q] - baseline[anchorPeriod])   for q >= anchorPeriod
   Flat baseline → the level just holds; a rising baseline keeps rising from the new level. */
function inputVal(v,p,scenario){
  const sched=schedule(v);
  if(scenario && model.ov && model.ov[v.key]){
    let a=-1; for(const k in model.ov[v.key]){ const ap=+k; if(ap<=p && ap>a) a=ap; }
    if(a>=0) return model.ov[v.key][a] + (sched[p]-sched[a]);
  }
  return sched[p];
}

/* Deterministic Kahn topological order among formulas (formula→formula edges only). */
function formulaTopoOrder(){
  const fs=formulas();
  const keys=new Set(fs.map(v=>v.key.toLowerCase()));
  const indeg={}, adj={}, byKey={};
  fs.forEach(v=>{ const k=v.key.toLowerCase(); byKey[k]=v; indeg[k]=0; adj[k]=[]; });
  fs.forEach(v=>{
    const k=v.key.toLowerCase();
    (v.compiled?.deps||[]).forEach(d=>{
      const dk=d.toLowerCase();
      if(keys.has(dk)){ adj[dk].push(k); indeg[k]=(indeg[k]||0)+1; }
    });
  });
  // deterministic: always dequeue the lexicographically smallest ready key
  const ready=Object.keys(indeg).filter(k=>indeg[k]===0).sort();
  const order=[];
  while(ready.length){
    const u=ready.shift();
    order.push(byKey[u]);
    (adj[u]||[]).forEach(w=>{
      indeg[w]--;
      if(indeg[w]===0){
        let i=0; while(i<ready.length && ready[i]<w) i++;
        ready.splice(i,0,w);
      }
    });
  }
  const ordered=new Set(order.map(v=>v.key.toLowerCase()));
  const leftover=fs.filter(v=>!ordered.has(v.key.toLowerCase()));
  return {order, leftover};
}
/* evaluate the whole graph, per period. scenario=true applies per-period input overrides */
function evalModel(scenario){
  const n=P(), res={};
  model.vars.forEach(v=>{ res[v.key]=new Array(n).fill(0); if(v.kind==='formula') v.err=''; });
  const {order, leftover}=formulaTopoOrder();
  leftover.forEach(v=>{ v.err=v.err||'Circular or unresolved dependency'; });
  for(let p=0;p<n;p++){
    const scope={};
    inputs().forEach(v=>{ const val=inputVal(v,p,scenario); scope[v.key.toLowerCase()]=val; res[v.key][p]=val; });
    outputs().forEach(v=>{ const val=(v.read&&v.read[p])||0; scope[v.key.toLowerCase()]=val; res[v.key][p]=val; });
    order.forEach(v=>{
      const deps=v.compiled?.deps||[];
      const missing=deps.filter(d=>!(d.toLowerCase() in scope));
      if(missing.length){
        v.err='Missing dependency: '+missing.join(', ');
        res[v.key][p]=NaN;
        scope[v.key.toLowerCase()]=NaN;
        return;
      }
      try{
        const val=evalRPN(v.compiled.rpn, scope);
        if(Number.isNaN(val)){ v.err=v.err||'Evaluation produced NaN'; }
        scope[v.key.toLowerCase()]=val;
        res[v.key][p]=val;
      }catch(e){
        v.err=String(e.message||e);
        res[v.key][p]=NaN;
        scope[v.key.toLowerCase()]=NaN;
      }
    });
    leftover.forEach(v=>{ res[v.key][p]=NaN; scope[v.key.toLowerCase()]=NaN; });
  }
  return res;
}

function assert(cond, msg){
  if(!cond){ console.error("FAIL:", msg); process.exitCode = 1; }
  else console.log("PASS:", msg);
}
function approx(a,b,eps=1e-6){ return Math.abs(a-b) < eps; }

console.log("=== Niche Numbers P0 engine tests ===");

{
  const v = evalRPN(compile("10 / 2").rpn, {});
  assert(approx(v, 5), "10/2 === 5 (got " + v + ")");
}

{
  let threw = false;
  try { evalRPN(compile("10 / 0").rpn, {}); }
  catch(e){ threw = /Division by zero/i.test(String(e.message||e)); }
  assert(threw, "10/0 throws Division by zero");
}

{
  model = {
    periods: ["M1","M2"],
    ov: {},
    vars: [
      {key:"price", name:"Price", unit:"Rs", kind:"input", base:950, steps:[], delta:0},
      {key:"distributors", name:"Distributors", unit:"#", kind:"input", base:100, steps:[], delta:0},
      {key:"units_per_dist", name:"Units per dist", unit:"#", kind:"input", base:120, steps:[], delta:0},
      {key:"volume", name:"Volume", unit:"#", kind:"formula", expr:"distributors * units_per_dist"},
      {key:"revenue", name:"Revenue", unit:"Rs", kind:"formula", expr:"price * volume"},
    ]
  };
  recompileAll();
  const res = evalModel(false);
  assert(approx(res.volume[0], 12000), "volume = 100*120 = 12000 (got " + res.volume[0] + ")");
  assert(approx(res.revenue[0], 11400000), "revenue = 950*12000 = 11400000 (got " + res.revenue[0] + ")");
  assert(!(model.vars.find(v=>v.key==="revenue").err), "revenue has no err");
}

{
  model = {
    periods: ["M1"],
    ov: {},
    vars: [
      {key:"A", name:"A", unit:"#", kind:"formula", expr:"B + 1"},
      {key:"B", name:"B", unit:"#", kind:"formula", expr:"2"},
    ]
  };
  recompileAll();
  const order = formulaTopoOrder().order.map(v=>v.key);
  assert(order.indexOf("B") < order.indexOf("A"), "topo order B before A (got " + order.join(",") + ")");
  const res = evalModel(false);
  assert(approx(res.B[0], 2), "B=2 (got " + res.B[0] + ")");
  assert(approx(res.A[0], 3), "A=B+1=3 (got " + res.A[0] + ")");
}

{
  model = {
    periods: ["M1"],
    ov: {},
    vars: [
      {key:"x", name:"X", unit:"#", kind:"formula", expr:"missing_var + 1"},
    ]
  };
  recompileAll();
  const res = evalModel(false);
  const xv = model.vars.find(v=>v.key==="x");
  assert(!!xv.err && /Missing dependency/i.test(xv.err), "missing dep sets v.err (got " + xv.err + ")");
  assert(Number.isNaN(res.x[0]), "missing dep yields NaN not 0 (got " + res.x[0] + ")");
}

if(process.exitCode){ console.error("\nSome tests failed"); process.exit(1); }
console.log("\nAll tests passed");
