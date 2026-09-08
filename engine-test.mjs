/** Isolated engine test harness (P0–P3). Run: node engine-test.mjs */
let model = { periods: ["P1"], ov: {}, vars: [] };

/* ---- expression compiler (shunting-yard → RPN) + FP&A helpers ---- */
const NN_FN_ARITY={lag:2, if:3, sum_periods:1, sum:1, pct:2};
const NN_FN_VREF=new Set(['lag','sum_periods','sum']); /* first arg is a variable reference */
function compile(expr){
  const toks=(String(expr).match(/[A-Za-z_][A-Za-z0-9_]*|\d+\.?\d*|[(),+\-*/]/g))||[];
  const out=[],ops=[],prec={'+':1,'-':1,'*':2,'/':2};
  const arityStack=[];
  const flushOp=o=>{
    if(typeof o==='object'&&o&&o.fn) return {fn:o.fn, arity:NN_FN_ARITY[o.fn]||o.arity||0};
    return {op:o};
  };
  for(let i=0;i<toks.length;i++){
    const t=toks[i];
    if(/^[\d.]/.test(t)) out.push({n:+t});
    else if(/^[A-Za-z_]/.test(t)){
      const fn=t.toLowerCase();
      if(NN_FN_ARITY[fn]!=null && toks[i+1]==='('){ ops.push({fn}); }
      else out.push({v:t});
    }
    else if(t==='('){
      ops.push(t);
      if(ops.length>=2 && typeof ops[ops.length-2]==='object' && ops[ops.length-2].fn){
        /* peek whether args are empty: next token ) → arity 0 */
        arityStack.push(toks[i+1]===')'?0:1);
      }
    }
    else if(t===','){
      while(ops.length && ops[ops.length-1]!=='(') out.push(flushOp(ops.pop()));
      if(arityStack.length) arityStack[arityStack.length-1]++;
    }
    else if(t===')'){
      while(ops.length && ops[ops.length-1]!=='(') out.push(flushOp(ops.pop()));
      if(ops.length && ops[ops.length-1]==='(') ops.pop();
      if(ops.length && typeof ops[ops.length-1]==='object' && ops[ops.length-1].fn){
        const f=ops.pop(); const expect=NN_FN_ARITY[f.fn];
        const got=arityStack.length?arityStack.pop():expect;
        if(expect!=null && got!==expect) throw new Error(f.fn+'() expects '+expect+' arg(s)');
        out.push({fn:f.fn, arity:expect});
      }
    }
    else {
      while(ops.length && typeof ops[ops.length-1]==='string' && ops[ops.length-1]!=='(' && prec[ops[ops.length-1]]>=prec[t])
        out.push(flushOp(ops.pop()));
      ops.push(t);
    }
  }
  while(ops.length){
    const o=ops.pop();
    if(o==='('||o===')') continue;
    out.push(flushOp(o));
  }
  /* rewrite lag/sum first-arg variables into {vref} so eval keeps the name */
  (function rewriteVrefs(rpn){
    const stack=[];
    for(let i=0;i<rpn.length;i++){
      const x=rpn[i];
      if('n' in x || 'v' in x || 'vref' in x){ stack.push(i); continue; }
      if(x.op){ stack.pop(); stack.pop(); stack.push(i); continue; }
      if(x.fn){
        const args=[]; for(let a=0;a<(x.arity||0);a++) args.unshift(stack.pop());
        if(NN_FN_VREF.has(x.fn) && args[0]!=null && rpn[args[0]] && 'v' in rpn[args[0]])
          rpn[args[0]]={vref:rpn[args[0]].v};
        stack.push(i);
      }
    }
  })(out);
  const deps=[...new Set(out.filter(x=>'v' in x || 'vref' in x).map(x=>x.v||x.vref))];
  return {rpn:out,deps};
}
/* Fixed-scale decimal arithmetic (integer micros at 1e8) for deterministic + - * / */
const NN_SCALE=1e8;
function nnToMicro(n){ const x=Number(n); return Number.isFinite(x)?Math.round(x*NN_SCALE):NaN; }
function nnFromMicro(m){ return Number.isFinite(m)?m/NN_SCALE:NaN; }
/* ctx optional: {period, lookup(key,q)} for lag / sum_periods across time */
function evalRPN(rpn,scope,ctx){
  const st=[];
  const period=(ctx&&ctx.period!=null)?ctx.period:0;
  const lookup=(ctx&&typeof ctx.lookup==='function')?ctx.lookup:(key,q)=>{
    if(q!==period) return 0;
    const raw=scope[String(key).toLowerCase()];
    return raw;
  };
  const pushNum=raw=>{
    if(raw===undefined || raw===null || (typeof raw==='number' && Number.isNaN(raw))) st.push(NaN);
    else st.push(nnToMicro(Number(raw)));
  };
  for(const x of rpn){
    if('n' in x) st.push(nnToMicro(x.n));
    else if('vref' in x) st.push({__ref:x.vref});
    else if('v' in x) pushNum(scope[x.v.toLowerCase()]);
    else if(x.fn){
      const args=[]; for(let i=0;i<(x.arity||0);i++) args.unshift(st.pop());
      if(x.fn==='lag'){
        const ref=args[0], nMicro=args[1];
        const key=ref&&ref.__ref; const n=Math.round(nnFromMicro(nMicro));
        const q=period-n;
        let val=0;
        if(key && q>=0){ const raw=lookup(key,q); if(raw!=null && raw!=='' && !(typeof raw==='number'&&Number.isNaN(raw))) val=Number(raw); }
        st.push(nnToMicro(val));
      } else if(x.fn==='sum_periods' || x.fn==='sum'){
        const ref=args[0]; const key=ref&&ref.__ref; let s=0;
        if(key){ for(let q=0;q<=period;q++){ const raw=lookup(key,q); if(raw!=null && raw!=='' && !(typeof raw==='number'&&Number.isNaN(raw))) s+=Number(raw); } }
        st.push(nnToMicro(s));
      } else if(x.fn==='if'){
        const cond=args[0], a=args[1], b=args[2];
        if(!Number.isFinite(cond)) st.push(NaN);
        else st.push(cond!==0 ? a : b);
      } else if(x.fn==='pct'){
        const a=args[0], b=args[1];
        if(!Number.isFinite(a) || !Number.isFinite(b)){ st.push(NaN); continue; }
        if(b===0) throw new Error('Division by zero');
        st.push(Math.round((a*100*NN_SCALE)/b));
      } else st.push(NaN);
    }
    else {
      const b=st.pop(), a=st.pop();
      if(a&&typeof a==='object'&&a.__ref || b&&typeof b==='object'&&b.__ref){ st.push(NaN); continue; }
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
  if(top&&typeof top==='object'&&top.__ref) return NaN;
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
function setOv(key,p,val){ if(!model.ov) model.ov={}; if(!model.ov[key]) model.ov[key]={}; model.ov[key][p]=+(+val).toFixed(4); }
function delOv(key,p){ if(model.ov&&model.ov[key]){ delete model.ov[key][p]; if(!Object.keys(model.ov[key]).length) delete model.ov[key]; } }
function hasOv(key){ return model.ov&&model.ov[key]&&Object.keys(model.ov[key]).length; }
function clearScenario(){ model.ov={}; renderAssumptions(); renderForecast(); saveModel(); }
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
        const val=evalRPN(v.compiled.rpn, scope, {period:p, lookup:(key,q)=>{
          if(q<0||q>=n) return 0;
          const sk=String(key).toLowerCase();
          if(q===p && (sk in scope)) return scope[sk];
          const kk=Object.keys(res).find(x=>x.toLowerCase()===sk);
          if(!kk) return 0;
          const raw=res[kk][q];
          return raw==null?0:raw;
        }});
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

console.log("=== Niche Numbers engine tests (P0–P3) ===");

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

/* ---- P1 helpers ---- */
{
  const c = compile("pct(10, 40)");
  assert(c.deps.length===0, "pct(10,40) has no var deps");
  const v = evalRPN(c.rpn, {});
  assert(approx(v, 25), "pct(10,40) === 25 (got " + v + ")");
}

{
  const c = compile("if(1, 10, 20)");
  assert(approx(evalRPN(c.rpn, {}), 10), "if(1,10,20) === 10");
  assert(approx(evalRPN(compile("if(0, 10, 20)").rpn, {}), 20), "if(0,10,20) === 20");
  assert(approx(evalRPN(compile("if(price, 1, 2)").rpn, {price:5}), 1), "if(truthy var)");
  assert(approx(evalRPN(compile("if(price, 1, 2)").rpn, {price:0}), 2), "if(zero var)");
}

{
  model = {
    periods: ["M1","M2","M3"],
    ov: {},
    vars: [
      {key:"units", name:"Units", unit:"#", kind:"input", base:10, steps:[{from:1,value:20},{from:2,value:30}], delta:0},
      {key:"prev", name:"Prev", unit:"#", kind:"formula", expr:"lag(units, 1)"},
      {key:"ytd", name:"YTD", unit:"#", kind:"formula", expr:"sum_periods(units)"},
      {key:"ytd2", name:"YTD2", unit:"#", kind:"formula", expr:"sum(units)"},
      {key:"share", name:"Share", unit:"%", kind:"formula", expr:"pct(units, ytd)"},
      {key:"bump", name:"Bump", unit:"#", kind:"formula", expr:"if(lag(units, 1), units - lag(units, 1), units)"},
    ]
  };
  recompileAll();
  const res = evalModel(false);
  assert(approx(res.prev[0], 0), "lag out of range → 0 (got " + res.prev[0] + ")");
  assert(approx(res.prev[1], 10), "lag(units,1) at M2 = 10 (got " + res.prev[1] + ")");
  assert(approx(res.prev[2], 20), "lag(units,1) at M3 = 20 (got " + res.prev[2] + ")");
  assert(approx(res.ytd[0], 10), "sum_periods M1 = 10 (got " + res.ytd[0] + ")");
  assert(approx(res.ytd[1], 30), "sum_periods M2 = 30 (got " + res.ytd[1] + ")");
  assert(approx(res.ytd[2], 60), "sum_periods M3 = 60 (got " + res.ytd[2] + ")");
  assert(approx(res.ytd2[2], 60), "sum() alias matches sum_periods");
  assert(approx(res.share[0], 100), "pct(units,ytd) M1 = 100 (got " + res.share[0] + ")");
  assert(approx(res.share[2], 50), "pct(units,ytd) M3 = 50 (got " + res.share[2] + ")");
  assert(approx(res.bump[0], 10), "if+lag first period = units (got " + res.bump[0] + ")");
  assert(approx(res.bump[1], 10), "if+lag delta M2 = 10 (got " + res.bump[1] + ")");
  model.vars.forEach(v=>{ if(v.kind==='formula') assert(!v.err, v.key+" has no err (got "+v.err+")"); });
}

{
  const c = compile("lag(revenue, 1) + pct(a, b)");
  assert(c.deps.map(d=>d.toLowerCase()).sort().join(",") === "a,b,revenue", "deps include vrefs + vars (got "+c.deps.join(",")+")");
}


/* ---- P2 wow helpers (pure) ---- */
function bridgeNarrative(opts){
  const line=opts.lineName||'Line', base=opts.baseLabel||'baseline';
  const tot=opts.totVar, fav=opts.fav, unit=opts.unit||'₹';
  const steps=(opts.steps||[]).filter(s=>Math.abs(s.delta)>1e-9).slice().sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta));
  const fmt=opts.fmtDelta||((d,u)=> (d>=0?'+':'−')+Math.abs(d));
  if(Math.abs(tot)<1e-9) return `vs ${base}, ${line} is flat — no material variance.`;
  const verdict = fav===true ? 'favourable' : fav===false ? 'unfavourable' : (tot>=0?'up':'down');
  let s=`vs ${base}, ${line} is ${verdict} by ${fmt(tot,unit)}.`;
  if(!steps.length) return s;
  const top=steps.slice(0,3);
  const bits2=top.map(st=>`${st.name} (${fmt(st.delta,unit)})`);
  s+=` Mainly because ${bits2.join(', ')}.`;
  if(steps.length>3) s+=` Plus ${steps.length-3} smaller driver${steps.length-3>1?'s':''}.`;
  return s;
}
/** Successive-substitution for one period: same idea as app bridge(win=[p,p]). */
function periodContribFromExpr(expr, depsA, depsB, scopeKeys){
  /* depsA/depsB: {key: number} driver values; evaluate expr with successive swap B→A */
  const c=compile(expr);
  const deps=c.deps.filter(d=>scopeKeys.includes(d)||scopeKeys.includes(d.toLowerCase()));
  const val=(sub)=>{
    const scope={};
    deps.forEach(d=>{ const k=d.toLowerCase(); scope[k]=sub.has(d)||sub.has(k)?depsA[d]??depsA[k]:depsB[d]??depsB[k]; });
    return evalRPN(c.rpn, scope);
  };
  let prev=val(new Set()); const steps=[];
  const used=new Set();
  deps.forEach(d=>{ used.add(d); const now=val(used); steps.push({key:d,delta:now-prev}); prev=now; });
  return {start:val(new Set()), end:prev, steps};
}

{
  const n=bridgeNarrative({lineName:'Revenue', baseLabel:'Plan', totVar:1000, fav:true, unit:'₹',
    steps:[{name:'Price',delta:600},{name:'Volume',delta:300},{name:'Mix',delta:80},{name:'Other',delta:20}],
    fmtDelta:(d)=> (d>=0?'+':'−')+'₹'+Math.abs(d)});
  assert(/favourable by \+₹1000/.test(n), "narrative fav amount (got "+n+")");
  assert(/Mainly because Price \(\+₹600\), Volume \(\+₹300\), Mix \(\+₹80\)/.test(n), "narrative top drivers (got "+n+")");
  assert(/Plus 1 smaller driver/.test(n), "narrative smaller drivers (got "+n+")");
}
{
  const n=bridgeNarrative({lineName:'Cost', baseLabel:'Budget', totVar:0, fav:null, unit:'₹', steps:[], fmtDelta:(d)=>String(d)});
  assert(/is flat/.test(n), "flat narrative");
}
{
  const r=periodContribFromExpr('price * volume', {price:110, volume:100}, {price:100, volume:100}, ['price','volume']);
  assert(approx(r.start, 10000), "contrib start 100*100 (got "+r.start+")");
  assert(approx(r.end, 11000), "contrib end 110*100 (got "+r.end+")");
  const priceStep=r.steps.find(s=>s.key==='price'||s.key==='Price');
  // deps order follows compile deps
  assert(r.steps.length===2, "two driver steps");
  assert(approx(r.steps.reduce((s,x)=>s+x.delta,0), 1000), "steps sum to gap (got "+r.steps.map(x=>x.delta)+")");
}



/* ---- P3: sheet formula A1 → expr + exact ×÷ breakback ---- */
function colToNum(c){ let n=0; for(const ch of String(c).toUpperCase()) if(ch>='A'&&ch<='Z') n=n*26+(ch.charCodeAt(0)-64); return n; }
function a1ColRow(ref){
  const m=String(ref||'').replace(/\$/g,'').match(/^([A-Za-z]+)(\d+)$/);
  if(!m) return null;
  return {col:m[1].toUpperCase(), row:+m[2], colNum:colToNum(m[1])};
}
function tokenizeSheetFormula(src){
  let s=String(src||'').trim();
  if(s.startsWith('=')) s=s.slice(1);
  const toks=[]; let i=0;
  while(i<s.length){
    const ch=s[i];
    if(/\s/.test(ch)){ i++; continue; }
    if('+-*/(),'.includes(ch)){ toks.push({t:'op', v:ch}); i++; continue; }
    if(/[0-9.]/.test(ch)){
      let j=i+1; while(j<s.length && /[0-9.]/.test(s[j])) j++;
      toks.push({t:'num', v:s.slice(i,j)}); i=j; continue;
    }
    if(ch==="'"){
      let j=i+1; while(j<s.length && s[j]!=="'") j++;
      if(j>=s.length){ toks.push({t:'bad', v:s.slice(i)}); break; }
      const sheet=s.slice(i+1,j); j++;
      if(s[j]==='!'){
        j++;
        const m=s.slice(j).match(/^\$?[A-Za-z]+\$?\d+/);
        if(!m){ toks.push({t:'bad', v:s.slice(i)}); break; }
        toks.push({t:'ref', sheet, a1:m[0].replace(/\$/g,'')}); i=j+m[0].length; continue;
      }
      toks.push({t:'bad', v:s.slice(i)}); break;
    }
    const rest=s.slice(i);
    const sheetRef=rest.match(/^([A-Za-z_][A-Za-z0-9_]*)!(\$?[A-Za-z]+\$?\d+)/);
    if(sheetRef){
      toks.push({t:'ref', sheet:sheetRef[1], a1:sheetRef[2].replace(/\$/g,'')});
      i+=sheetRef[0].length; continue;
    }
    const cell=rest.match(/^\$?[A-Za-z]+\$?\d+/);
    if(cell){
      toks.push({t:'ref', sheet:'', a1:cell[0].replace(/\$/g,'')});
      i+=cell[0].length; continue;
    }
    const ident=rest.match(/^[A-Za-z_][A-Za-z0-9_.]*/);
    if(ident){ toks.push({t:'ident', v:ident[0]}); i+=ident[0].length; continue; }
    toks.push({t:'bad', v:ch}); i++;
  }
  return toks;
}
function sheetFormulaToExpr(formula, cellMap, defaultSheet){
  const toks=tokenizeSheetFormula(formula);
  if(!toks.length) return {ok:false, reason:'empty'};
  if(toks.some(t=>t.t==='bad')) return {ok:false, reason:'unsupported token'};
  if(toks.some(t=>t.t==='ident')) return {ok:false, reason:'function or name'};
  const parts=[]; const deps=[]; const unresolved=[];
  const ds=String(defaultSheet||'').trim();
  for(const t of toks){
    if(t.t==='op'){ parts.push(t.v==='/'?' / ':t.v==='*'?' * ':t.v==='+'?' + ':t.v==='-'?' - ':t.v); continue; }
    if(t.t==='num'){ parts.push(t.v); continue; }
    if(t.t==='ref'){
      const cr=a1ColRow(t.a1); if(!cr){ unresolved.push(t.a1); parts.push('?'); continue; }
      const sh=(t.sheet||ds||'').trim();
      const keys=[
        (sh?sh+'!':'')+cr.col+cr.row,
        cr.col+cr.row,
        (sh?sh.toUpperCase()+'!':'')+cr.col+cr.row
      ].map(k=>k.toUpperCase());
      let key=null;
      for(const k of keys){ if(cellMap[k]){ key=cellMap[k]; break; } }
      if(!key){
        for(const mk of Object.keys(cellMap)){
          const bare=mk.includes('!')?mk.split('!').pop():mk;
          if(bare===cr.col+cr.row){ key=cellMap[mk]; break; }
        }
      }
      if(!key){ unresolved.push((sh?sh+'!':'')+cr.col+cr.row); parts.push('?'); continue; }
      parts.push(key); deps.push(key); continue;
    }
  }
  if(unresolved.length) return {ok:false, reason:'unresolved '+unresolved.join(','), unresolved};
  const expr=parts.join('').replace(/\s+/g,' ').trim();
  try{ compile(expr); }catch(e){ return {ok:false, reason:String(e.message||e)}; }
  return {ok:true, expr, deps:[...new Set(deps)]};
}

{
  const map={B2:'price', B3:'volume', 'B2':'price', 'B3':'volume'};
  Object.keys(map).forEach(k=>{ map[k.toUpperCase()]=map[k]; });
  const r=sheetFormulaToExpr('=$B$2*$B$3', map, '');
  assert(r.ok, "parse $B$2*$B$3 ok");
  assert(r.expr.replace(/\s/g,'')==='price*volume', "expr is price*volume (got "+r.expr+")");
  const mapPL=Object.assign({}, map);
  mapPL['P&L!B2']='revenue'; mapPL['P&L!B2'.toUpperCase()]='revenue'; mapPL['B3']='units'; mapPL['B3']='units';
  const r2=sheetFormulaToExpr("='P&L'!B2/B3", mapPL, 'P&L');
  assert(r2.ok && /revenue\s*\/\s*units/.test(r2.expr), "quoted sheet ref parse (got "+(r2.expr||r2.reason)+")");
  const map3={'B5':'distributors','B6':'units_per_dist'};
  Object.keys(map3).forEach(k=>{ map3[k.toUpperCase()]=map3[k]; });
  const r3=sheetFormulaToExpr('=B5*B6', map3, 'Forecast');
  assert(r3.ok && r3.expr.replace(/\s/g,'')==='distributors*units_per_dist', "B5*B6 → distributors*units_per_dist (got "+(r3.expr||r3.reason)+")");
  const r4=sheetFormulaToExpr('=SUM(B2:B10)', map, '');
  assert(!r4.ok, "SUM range not silently accepted");
  const r5=sheetFormulaToExpr('=B2+B3', map, '');
  assert(r5.ok && /price\s*\+\s*volume/.test(r5.expr), "addition maps too (got "+r5.expr+")");
}

/* Minimal exact backsolve harness mirroring app monomial + proportional scale */
function monomialFactorizationTest(key, period, leafKeys){
  const leafSet=new Set(leafKeys.map(k=>k.toLowerCase()));
  const memo={};
  function fac(k, seen){
    const kl=String(k).toLowerCase();
    if(kl in memo) return memo[kl];
    if(seen.has(kl)) return memo[kl]={ok:false};
    seen=new Set(seen); seen.add(kl);
    const v=vget(k)||model.vars.find(x=>x.key.toLowerCase()===kl);
    if(!v) return memo[kl]={ok:false};
    if(v.kind==='input'){
      if(!leafSet.has(v.key.toLowerCase()) && !leafSet.has(kl)){
        const val=inputVal(v,period,true);
        return memo[kl]={ok:true, exp:{}, c:Number(val)};
      }
      const exp={}; exp[v.key]=1;
      return memo[kl]={ok:true, exp, c:1};
    }
    if(v.kind!=='formula') return memo[kl]={ok:false};
    let compiled; try{ compiled=v.compiled&&v.compiled.rpn?v.compiled:compile(v.expr); }catch(e){ return memo[kl]={ok:false}; }
    const st=[];
    for(const x of compiled.rpn){
      if('n' in x){ st.push({ok:true, exp:{}, c:x.n}); continue; }
      if('vref' in x) return memo[kl]={ok:false};
      if('v' in x){ st.push(fac(x.v, seen)); continue; }
      if(x.fn) return memo[kl]={ok:false};
      if(x.op){
        const b=st.pop(), a=st.pop();
        if(!a||!b||!a.ok||!b.ok) return memo[kl]={ok:false};
        if(x.op==='*'){
          const exp={}; Object.keys(a.exp).forEach(k=>exp[k]=(exp[k]||0)+a.exp[k]);
          Object.keys(b.exp).forEach(k=>exp[k]=(exp[k]||0)+b.exp[k]);
          st.push({ok:true, exp, c:a.c*b.c}); continue;
        }
        if(x.op==='/'){
          if(Math.abs(b.c)<1e-15) return memo[kl]={ok:false};
          const exp={}; Object.keys(a.exp).forEach(k=>exp[k]=(exp[k]||0)+a.exp[k]);
          Object.keys(b.exp).forEach(k=>exp[k]=(exp[k]||0)-b.exp[k]);
          st.push({ok:true, exp, c:a.c/b.c}); continue;
        }
        return memo[kl]={ok:false};
      }
    }
    if(st.length!==1||!st[0].ok) return memo[kl]={ok:false};
    return memo[kl]=st[0];
  }
  const r=fac(key, new Set());
  if(!r||!r.ok) return {ok:false};
  const exp={}; Object.keys(r.exp).forEach(k=>{ if(Math.abs(r.exp[k])>1e-12) exp[k]=r.exp[k]; });
  return {ok:true, exponents:exp, constant:r.c};
}

{
  model = {
    periods: ["M1"],
    ov: {},
    vars: [
      {key:"price", name:"Price", unit:"Rs", kind:"input", base:100, steps:[], delta:0},
      {key:"volume", name:"Volume", unit:"#", kind:"input", base:50, steps:[], delta:0},
      {key:"revenue", name:"Revenue", unit:"Rs", kind:"formula", expr:"price * volume"},
    ]
  };
  recompileAll();
  const y0 = evalModel(true).revenue[0];
  assert(approx(y0, 5000), "price*volume base 5000 (got "+y0+")");
  const leaves = [vget('price'), vget('volume')];
  const fac = monomialFactorizationTest('revenue', 0, ['price','volume']);
  assert(fac.ok, "monomial ok for price*volume");
  assert(fac.exponents.price===1 && fac.exponents.volume===1, "exponents 1,1");
  const target = 8000;
  const ratio = target / y0;
  const psum = 2;
  let r = Math.pow(ratio, 1/psum);
  leaves.forEach(v=> setOv(v.key, 0, (v.base)*r));
  let y1 = evalModel(true).revenue[0];
  const corr = Math.pow(target/y1, 1/psum);
  r *= corr;
  leaves.forEach(v=> setOv(v.key, 0, (v.base)*r));
  y1 = evalModel(true).revenue[0];
  assert(approx(y1, 8000, 0.02), "exact proportional backsolve revenue→8000 (got "+y1+")");
}

{
  model = {
    periods: ["M1"],
    ov: {},
    vars: [
      {key:"price", name:"Price", unit:"Rs", kind:"input", base:100, steps:[], delta:0},
      {key:"volume", name:"Volume", unit:"#", kind:"input", base:50, steps:[], delta:0},
      {key:"revenue", name:"Revenue", unit:"Rs", kind:"formula", expr:"price * volume"},
    ]
  };
  recompileAll();
  /* single-leaf: only price free */
  const y0 = evalModel(true).revenue[0];
  const target = 6000;
  const fac = monomialFactorizationTest('revenue', 0, ['price']);
  assert(fac.ok && fac.exponents.price===1, "single-leaf monomial");
  const scale = target/y0;
  setOv('price', 0, 100*scale);
  const y1 = evalModel(true).revenue[0];
  assert(approx(y1, 6000, 1e-4), "exact single-driver price drag (got "+y1+")");
  assert(approx(model.ov.price[0], 120, 1e-4), "price→120 (got "+model.ov.price[0]+")");
}

{
  model = {
    periods: ["M1"],
    ov: {},
    vars: [
      {key:"a", name:"A", unit:"#", kind:"input", base:10, steps:[], delta:0},
      {key:"b", name:"B", unit:"#", kind:"input", base:5, steps:[], delta:0},
      {key:"s", name:"S", unit:"#", kind:"formula", expr:"a + b"},
    ]
  };
  recompileAll();
  const fac = monomialFactorizationTest('s', 0, ['a','b']);
  assert(!fac.ok, "a+b is not a monomial — fall back to numeric");
}


if(process.exitCode){ console.error("\nSome tests failed"); process.exit(1); }
console.log("\nAll tests passed");
