import { useState, useEffect, useRef } from "react";

const API = "/api";
const ROLES = [
  { id: "devils_advocate", name: "Devil's Advocate", icon: "🔥", desc: "Challenges assumptions and probes for weaknesses", mode: "active", color: "#EF4444" },
  { id: "technical_reviewer", name: "Technical Reviewer", icon: "⚙️", desc: "Evaluates feasibility and flags technical concerns", mode: "hybrid", color: "#F59E0B" },
  { id: "meeting_scribe", name: "Meeting Scribe", icon: "📝", desc: "Silent observer — captures notes and actions", mode: "observer", color: "#10B981" },
  { id: "code_reviewer", name: "Code Reviewer", icon: "💻", desc: "Analyzes screenshared code for bugs", mode: "hybrid", color: "#8B5CF6" },
  { id: "brainstorm_partner", name: "Brainstorm Partner", icon: "💡", desc: "Actively contributes creative ideas", mode: "active", color: "#06B6D4" },
  { id: "compliance_officer", name: "Compliance Officer", icon: "🛡️", desc: "Monitors for legal and regulatory concerns", mode: "hybrid", color: "#EC4899" },
];
const MODES = {
  active: { label: "Active", desc: "Speaks proactively", color: "#EF4444" },
  reactive: { label: "Reactive", desc: "Speaks when addressed", color: "#F59E0B" },
  observer: { label: "Observer", desc: "Silent — reports after", color: "#10B981" },
  hybrid: { label: "Hybrid", desc: "Interjects at key moments", color: "#8B5CF6" },
};

export default function App() {
  const [page, setPage] = useState("deploy");
  const [session, setSession] = useState(null);
  const [summary, setSummary] = useState(null);
  return (
    <div style={S.app}>
      <style>{CSS}</style>
      <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"/>
      <Header page={page} session={session}/>
      <main style={S.main}>
        {page==="deploy" && <DeployPage onStart={s=>{setSession(s);setPage("live")}}/>}
        {page==="live" && session && <LivePage session={session} onEnd={s=>{setSummary(s);setPage("review")}} />}
        {page==="review" && <ReviewPage summary={summary} session={session} onNew={()=>{setSession(null);setSummary(null);setPage("deploy")}}/>}
      </main>
    </div>
  );
}

function Header({page,session}) {
  return (
    <header style={S.header}>
      <div style={S.logo}><span style={{fontSize:22}}>🧠</span><span style={S.logoText}>MeetMind</span><span style={S.badge}>AI</span></div>
      <div style={S.nav}>
        {["deploy","live","review"].map((p,i)=>(
          <span key={p} style={{display:"flex",alignItems:"center",gap:4}}>
            {i>0&&<span style={{color:"#334155",fontSize:11}}>→</span>}
            <span style={{...S.pill,...(page===p?S.pillActive:{})}}><span style={{width:6,height:6,borderRadius:"50%",background:page===p?"#818CF8":"#334155",display:"inline-block"}}/>{p.charAt(0).toUpperCase()+p.slice(1)}</span>
          </span>
        ))}
      </div>
      <div>{session && <span style={S.sessionTag}><span style={{width:8,height:8,borderRadius:"50%",background:"#10B981",animation:"pulse 2s infinite"}}/>{session.role_name}</span>}</div>
    </header>
  );
}

function DeployPage({onStart}) {
  const [url,setUrl]=useState("");
  const [role,setRole]=useState(null);
  const [vision,setVision]=useState(true);
  const [deploying,setDeploying]=useState(false);
  const [err,setErr]=useState(null);
  const ok = url.includes("meet.google.com") && role;

  const deploy = async()=>{
    setDeploying(true); setErr(null);
    try {
      const r = await fetch(`${API}/deploy`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({meeting_url:url,role_id:role,vision_enabled:vision})});
      if(!r.ok) throw new Error((await r.json()).detail||`Error ${r.status}`);
      onStart(await r.json());
    } catch(e){ setErr(e.message); onStart({session_id:"demo_"+Date.now(),role_name:ROLES.find(r=>r.id===role)?.name||"Agent",mode:ROLES.find(r=>r.id===role)?.mode||"reactive",status:"demo"}); }
    finally { setDeploying(false); }
  };

  return (
    <div style={S.grid2}>
      <div style={S.col}>
        <Card title="Meeting target" icon="📡">
          <label style={S.label}>Google Meet URL</label>
          <input style={S.input} placeholder="https://meet.google.com/abc-defg-hij" value={url} onChange={e=>setUrl(e.target.value)}/>
        </Card>
        <Card title="Capabilities" icon="🎛️">
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div><div style={{fontSize:14,fontWeight:500,color:"#E2E8F0"}}>Screen vision</div><div style={{fontSize:11,color:"#64748B"}}>See and analyze shared screens</div></div>
            <div onClick={()=>setVision(!vision)} style={{width:44,height:24,borderRadius:12,background:vision?"#6366F1":"#1E293B",position:"relative",cursor:"pointer"}}><div style={{width:20,height:20,borderRadius:"50%",background:"#fff",position:"absolute",top:2,transition:"transform .2s",transform:vision?"translateX(20px)":"translateX(2px)"}}/></div>
          </div>
        </Card>
        <button disabled={!ok||deploying} onClick={deploy} style={{...S.deployBtn,opacity:ok&&!deploying?1:.4,cursor:ok&&!deploying?"pointer":"not-allowed"}}>{deploying?"⏳ Deploying...":"🚀 Deploy MeetMind Agent"}</button>
        {err && <div style={S.errBanner}>⚠️ {err} — running demo mode</div>}
      </div>
      <div>
        <Card title="Select role" icon="🎭">
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            {ROLES.map(r=>(
              <div key={r.id} onClick={()=>setRole(r.id)} style={{...S.roleCard,borderColor:role===r.id?r.color:"#1E293B",background:role===r.id?r.color+"10":"#0F172A",boxShadow:role===r.id?`0 0 20px ${r.color}25`:"none",cursor:"pointer"}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}><span style={{fontSize:22}}>{r.icon}</span><span style={{fontSize:10,fontFamily:"'JetBrains Mono'",fontWeight:600,padding:"3px 8px",borderRadius:12,background:MODES[r.mode]?.color+"25",color:MODES[r.mode]?.color}}>{MODES[r.mode]?.label}</span></div>
                <div style={{fontWeight:600,fontSize:13,color:"#F1F5F9",marginBottom:3}}>{r.name}</div>
                <div style={{fontSize:11,color:"#64748B",lineHeight:1.4}}>{r.desc}</div>
                {role===r.id && <div style={{position:"absolute",bottom:0,left:0,right:0,textAlign:"center",padding:3,fontSize:10,fontWeight:600,color:"#fff",background:r.color,borderRadius:"0 0 8px 8px"}}>✓ Selected</div>}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function LivePage({session,onEnd}) {
  const [status,setStatus]=useState("connecting");
  const [transcript,setTranscript]=useState([]);
  const [elapsed,setElapsed]=useState(0);
  const [frames,setFrames]=useState(0);
  const [msg,setMsg]=useState("");
  const wsRef=useRef(null);
  const scrollRef=useRef(null);

  useEffect(()=>{const t=setInterval(()=>setElapsed(e=>e+1),1000);return()=>clearInterval(t)},[]);
  useEffect(()=>{scrollRef.current&&(scrollRef.current.scrollTop=scrollRef.current.scrollHeight)},[transcript]);

  // WebSocket
  useEffect(()=>{
    try {
      const ws=new WebSocket(`${location.protocol==="https:"?"wss:":"ws:"}//${location.host}/ws/dashboard`);
      ws.onopen=()=>setStatus("in_meeting");
      ws.onmessage=e=>{
        const d=JSON.parse(e.data);
        if(d.type==="transcript") setTranscript(p=>[...p,{text:d.text,speaker:d.speaker,kind:d.kind,isAgent:d.is_agent,time:new Date().toLocaleTimeString()}]);
        if(d.type==="frame_received") setFrames(f=>f+1);
        if(d.type==="bot_status") setStatus(d.status);
      };
      ws.onerror=()=>{};
      wsRef.current=ws;
    } catch(e){}
    // Demo fallback
    const t=setTimeout(()=>setStatus("in_meeting"),2000);
    const fi=setInterval(()=>{if(status==="in_meeting")setFrames(f=>f+1)},1000);
    return()=>{wsRef.current?.close();clearTimeout(t);clearInterval(fi)};
  },[]);

  const send=()=>{
    if(!msg.trim())return;
    fetch(`${API}/session/message`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text:msg})}).catch(()=>{});
    setTranscript(p=>[...p,{text:msg,speaker:"Dashboard",kind:"dashboard",isAgent:false,time:new Date().toLocaleTimeString()}]);
    setMsg("");
  };

  const end=async()=>{
    try {
      const r=await fetch(`${API}/session/end`,{method:"POST"});
      const d=await r.json(); onEnd(d);
    } catch(e){
      onEnd({notes:[{category:"decision",content:"Team agreed to proceed with Phase 2"}],action_items:[{task:"Draft revised timeline",owner:"Sarah",deadline:"Friday",priority:"high"}],summary_context:"Demo summary",gemini_stats:{text_inputs:0,frame_inputs:frames,responses_generated:0}});
    }
  };

  const fmt=s=>`${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;

  return (
    <div>
      <div style={S.statusBar}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{width:10,height:10,borderRadius:"50%",background:status==="in_meeting"||status==="joined"?"#10B981":"#F59E0B",boxShadow:`0 0 8px ${status==="in_meeting"||status==="joined"?"#10B98180":"#F59E0B80"}`,animation:"pulse 2s infinite"}}/>
          <span style={S.mono}>{status==="in_meeting"||status==="joined"?"In meeting":status}</span>
        </div>
        <div style={{display:"flex",gap:24}}>
          {[["TIME",fmt(elapsed)],["ROLE",session.role_name],["MODE",session.mode.toUpperCase()],["FRAMES",String(frames)]].map(([l,v])=>(
            <div key={l} style={{textAlign:"center"}}><div style={{fontSize:9,fontFamily:"'JetBrains Mono'",color:"#475569",textTransform:"uppercase",letterSpacing:1}}>{l}</div><div style={S.mono}>{v}</div></div>
          ))}
        </div>
        <button style={S.endBtn} onClick={end}>■ End session</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 300px",height:"calc(100vh - 190px)"}}>
        <div style={{display:"flex",flexDirection:"column",background:"#0F172A",border:"1px solid #1E293B",borderTop:"none",borderRadius:"0 0 0 12px"}}>
          <div style={S.panelHead}><span style={S.panelTitle}>Live transcript</span><span style={{fontSize:10,color:"#475569",fontFamily:"'JetBrains Mono'"}}>{transcript.length} entries</span></div>
          <div ref={scrollRef} style={{flex:1,overflowY:"auto",padding:"12px 18px"}}>
            {transcript.length===0 && <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",gap:8,color:"#64748B",fontSize:13}}>🎙️<div>Listening to meeting audio...</div></div>}
            {transcript.map((t,i)=>(
              <div key={i} style={{padding:"8px 12px",marginBottom:6,borderRadius:"0 8px 8px 0",background:"#0A0F1E",borderLeft:`3px solid ${t.isAgent?"#818CF8":t.kind==="dashboard"?"#F59E0B":"#334155"}`}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                  <span style={{fontSize:11,fontWeight:600,fontFamily:"'JetBrains Mono'",color:t.isAgent?"#818CF8":t.kind==="dashboard"?"#F59E0B":"#94A3B8"}}>{t.isAgent?"🧠 MeetMind":t.kind==="dashboard"?"📨 Dashboard":`👤 ${t.speaker}`}</span>
                  <span style={{fontSize:10,color:"#475569",fontFamily:"'JetBrains Mono'"}}>{t.time}</span>
                </div>
                <div style={{fontSize:13,color:"#CBD5E1",lineHeight:1.5}}>{t.text}</div>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:8,padding:"12px 18px",borderTop:"1px solid #1E293B"}}>
            <input style={{...S.input,flex:1,fontSize:13}} placeholder="Send a message to the agent..." value={msg} onChange={e=>setMsg(e.target.value)} onKeyDown={e=>e.key==="Enter"&&send()}/>
            <button style={{padding:"10px 16px",background:"#4F46E5",border:"none",borderRadius:8,color:"#fff",fontSize:16,cursor:"pointer",fontWeight:700}} onClick={send}>↵</button>
          </div>
        </div>
        <div style={{background:"#0D1324",border:"1px solid #1E293B",borderTop:"none",borderLeft:"none",borderRadius:"0 0 12px 0",padding:18}}>
          <div style={S.panelTitle}>Agent activity</div>
          {[["🔊","Audio pipeline",status==="in_meeting"||status==="joined"?"#10B981":"#F59E0B"],["📸","Screen capture",frames>0?"#10B981":"#F59E0B"],["🧠",`Role: ${session.role_name}`,"#818CF8"],["🎯",`Mode: ${session.mode}`,"#818CF8"],["📊",`Frames: ${frames}`,"#64748B"]].map(([ic,lb,cl])=>(
            <div key={lb} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:"1px solid #1E293B15",fontSize:12}}>
              <span>{ic}</span><span style={{flex:1,color:"#94A3B8"}}>{lb}</span><span style={{width:8,height:8,borderRadius:"50%",background:cl}}/>
            </div>
          ))}
          <div style={{...S.panelTitle,marginTop:20,marginBottom:8}}>Quick commands</div>
          {["Summarize discussion so far","What action items have been mentioned?","What's on the screen right now?","Any concerns about what was discussed?"].map(c=>(
            <button key={c} style={S.quickCmd} onClick={()=>{setMsg(c);setTimeout(send,50)}}>{c}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReviewPage({summary,session,onNew}) {
  if(!summary) return null;
  const notes = summary.notes||[];
  const actions = summary.action_items||[];
  const stats = summary.gemini_stats||{};
  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:24}}>
        <div>
          <h2 style={{fontFamily:"'JetBrains Mono'",fontSize:24,fontWeight:700,color:"#F1F5F9",margin:"0 0 6px"}}>Meeting report</h2>
          <div style={{fontSize:13,color:"#64748B"}}>Role: <strong>{session?.role_name}</strong> | Mode: <strong>{session?.mode}</strong> | Frames: <strong>{stats.frame_inputs||0}</strong> | Responses: <strong>{stats.responses_generated||0}</strong></div>
        </div>
        <button onClick={onNew} style={{padding:"10px 20px",background:"#6366F1",border:"none",borderRadius:8,color:"#fff",fontWeight:600,cursor:"pointer"}}>+ New session</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
        <Card title="Meeting notes" icon="📋">
          {notes.length===0?<div style={{color:"#475569",fontStyle:"italic"}}>No notes captured</div>:notes.map((n,i)=>(
            <div key={i} style={{display:"flex",alignItems:"flex-start",gap:10,padding:"10px 0",borderBottom:"1px solid #1E293B"}}>
              <span style={{fontSize:10,fontFamily:"'JetBrains Mono'",fontWeight:600,padding:"3px 8px",borderRadius:6,flexShrink:0,textTransform:"uppercase",background:n.category==="decision"?"#10B98125":"#818CF825",color:n.category==="decision"?"#10B981":"#818CF8"}}>{n.category}</span>
              <span style={{fontSize:13,color:"#CBD5E1",lineHeight:1.4}}>{n.content}</span>
            </div>
          ))}
        </Card>
        <Card title="Action items" icon="✅">
          {actions.length===0?<div style={{color:"#475569",fontStyle:"italic"}}>No action items captured</div>:actions.map((a,i)=>(
            <div key={i} style={{padding:"12px 0",borderBottom:"1px solid #1E293B"}}>
              <div style={{fontSize:14,fontWeight:500,color:"#E2E8F0",marginBottom:6}}>{a.task}</div>
              <div style={{display:"flex",gap:14,fontSize:12}}>
                <span style={{color:"#818CF8"}}>👤 {a.owner}</span>
                <span style={{color:"#F59E0B"}}>📅 {a.deadline}</span>
                <span style={{fontWeight:600,color:a.priority==="high"?"#EF4444":a.priority==="medium"?"#F59E0B":"#10B981"}}>● {a.priority}</span>
              </div>
            </div>
          ))}
        </Card>
      </div>
      {summary.summary_context && (
        <Card title="Raw context" icon="📄">
          <pre style={{fontSize:12,color:"#94A3B8",whiteSpace:"pre-wrap",lineHeight:1.5,margin:0}}>{summary.summary_context}</pre>
        </Card>
      )}
    </div>
  );
}

function Card({title,icon,children}) {
  return (
    <div style={{background:"#0F172A",border:"1px solid #1E293B",borderRadius:12,marginBottom:16,overflow:"hidden"}}>
      <div style={{display:"flex",alignItems:"center",gap:8,padding:"12px 18px",borderBottom:"1px solid #1E293B",background:"#0D1324"}}>
        <span style={{fontSize:16}}>{icon}</span>
        <span style={{fontFamily:"'JetBrains Mono'",fontSize:13,fontWeight:600,color:"#CBD5E1"}}>{title}</span>
      </div>
      <div style={{padding:18}}>{children}</div>
    </div>
  );
}

const S = {
  app: { minHeight:"100vh",background:"#0A0F1E",color:"#E2E8F0",fontFamily:"'DM Sans',sans-serif" },
  main: { maxWidth:1200,margin:"0 auto",padding:"24px 20px" },
  header: { display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 24px",background:"#0F172A",borderBottom:"1px solid #1E293B",position:"sticky",top:0,zIndex:50 },
  logo: { display:"flex",alignItems:"center",gap:8 },
  logoText: { fontFamily:"'JetBrains Mono'",fontWeight:700,fontSize:18,color:"#F1F5F9" },
  badge: { fontFamily:"'JetBrains Mono'",fontSize:10,fontWeight:600,background:"#6366F1",color:"#fff",padding:"2px 6px",borderRadius:4,letterSpacing:1 },
  nav: { display:"flex",alignItems:"center",gap:6 },
  pill: { display:"flex",alignItems:"center",gap:6,padding:"6px 14px",borderRadius:20,fontSize:12,fontWeight:500,fontFamily:"'JetBrains Mono'",background:"#0F172A",border:"1px solid #1E293B" },
  pillActive: { background:"#1E1B4B",borderColor:"#4338CA" },
  sessionTag: { display:"flex",alignItems:"center",gap:8,padding:"6px 12px",background:"#10B98115",border:"1px solid #10B98140",borderRadius:20,fontSize:12,fontFamily:"'JetBrains Mono'",color:"#10B981" },
  grid2: { display:"grid",gridTemplateColumns:"380px 1fr",gap:24,alignItems:"start" },
  col: { display:"flex",flexDirection:"column",gap:16 },
  label: { display:"block",fontSize:11,fontFamily:"'JetBrains Mono'",fontWeight:500,color:"#64748B",marginBottom:6,textTransform:"uppercase",letterSpacing:.8 },
  input: { width:"100%",padding:"12px 14px",background:"#0A0F1E",border:"1px solid #1E293B",borderRadius:8,color:"#E2E8F0",fontSize:14,fontFamily:"'DM Sans'",outline:"none",boxSizing:"border-box" },
  roleCard: { padding:16,borderRadius:10,border:"1.5px solid #1E293B",transition:"all .2s",position:"relative" },
  deployBtn: { width:"100%",padding:16,background:"linear-gradient(135deg,#6366F1,#4F46E5)",border:"none",borderRadius:12,color:"#fff",fontSize:16,fontWeight:700,fontFamily:"'DM Sans'",boxShadow:"0 4px 24px #6366F140" },
  errBanner: { padding:"10px 14px",background:"#F59E0B15",border:"1px solid #F59E0B40",borderRadius:8,fontSize:12,color:"#F59E0B",textAlign:"center" },
  statusBar: { display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 20px",background:"#0F172A",border:"1px solid #1E293B",borderRadius:"12px 12px 0 0" },
  mono: { fontSize:13,fontFamily:"'JetBrains Mono'",fontWeight:600,color:"#E2E8F0" },
  endBtn: { padding:"8px 18px",background:"#7F1D1D",border:"1px solid #991B1B",borderRadius:8,color:"#FCA5A5",fontSize:12,fontWeight:600,fontFamily:"'JetBrains Mono'",cursor:"pointer" },
  panelHead: { display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 18px",borderBottom:"1px solid #1E293B" },
  panelTitle: { fontFamily:"'JetBrains Mono'",fontSize:12,fontWeight:600,color:"#94A3B8",textTransform:"uppercase",letterSpacing:1 },
  quickCmd: { display:"block",width:"100%",padding:"8px 12px",background:"#0A0F1E",border:"1px solid #1E293B",borderRadius:6,color:"#94A3B8",fontSize:11,textAlign:"left",cursor:"pointer",marginBottom:6,fontFamily:"'DM Sans'" },
};

const CSS = `
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
*{box-sizing:border-box}body{margin:0;background:#0A0F1E}
input:focus,textarea:focus{border-color:#6366F1!important;box-shadow:0 0 0 2px #6366F120}
button:hover{filter:brightness(1.1)}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:#0A0F1E}::-webkit-scrollbar-thumb{background:#1E293B;border-radius:3px}
`;
