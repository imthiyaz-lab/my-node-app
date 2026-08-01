require("dotenv").config();
const express = require("express");
const cors = require("cors");
const sql = require("mssql");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT || 3000);

// ---------------------- DB CONFIG ----------------------
function buildDbConfig() {
  const server = process.env.DB_SERVER || "127.0.0.1";
  const database = process.env.DB_NAME || "imtu";
  const userName = process.env.DB_USER || "sa";
  const password = process.env.DB_PASSWORD || "sa!123@Pass";
  const trustServerCertificate = true;

  return {
    server,
    authentication: {
      type: "default",
      options: { userName, password }
    },
    options: {
      database,
      encrypt: false,
      trustServerCertificate
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
  };
}

let pool = null;

async function getPool() {
  if (!pool) pool = await sql.connect(buildDbConfig());
  return pool;
}

function safe(v) {
  return String(v == null ? "" : v).trim();
}

// ---------------------- TABLE SETUP ----------------------
async function ensureTb6r() {
  const p = await getPool();

  await p.request().query(`
    IF OBJECT_ID('dbo.tb6r','U') IS NULL
    BEGIN
      CREATE TABLE dbo.tb6r (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        JobId NVARCHAR(100) NOT NULL UNIQUE,
        JobType NVARCHAR(30) NULL,
        Technology NVARCHAR(100) NULL,
        SourceServer NVARCHAR(255) NULL,
        DatabaseName NVARCHAR(255) NULL,
        Environment NVARCHAR(50) NULL,
        DevTestProd NVARCHAR(50) NULL,
        DBVersion NVARCHAR(100) NULL,
        ProjectRuby NVARCHAR(10) NULL,
        RequestNo NVARCHAR(100) NULL,
        AssignedTo NVARCHAR(150) NULL,
        SoakStatus NVARCHAR(50) NULL,
        DBSize NVARCHAR(50) NULL,
        StorageReclaimed NVARCHAR(50) NULL,
        Phase1Date NVARCHAR(30) NULL,
        Phase2Date NVARCHAR(30) NULL,
        TargetServer NVARCHAR(255) NULL,
        NewDbName NVARCHAR(255) NULL,
        Completed BIT NOT NULL DEFAULT 0,
        HasError BIT NOT NULL DEFAULT 0,
        StartedAt DATETIME2 NULL,
        CompletedAt DATETIME2 NULL,
        Comments NVARCHAR(MAX) NULL
      );
    END
    
  `);

  // Optional: business-rule unique index for decommission Source+DB
  await p.request().query(`
    IF NOT EXISTS (
      SELECT 1
      FROM sys.indexes
      WHERE name = 'UX_tb6r_Decom_Source_DB'
        AND object_id = OBJECT_ID('dbo.tb6r')
    )
    BEGIN
      CREATE UNIQUE INDEX UX_tb6r_Decom_Source_DB
      ON dbo.tb6r(SourceServer, DatabaseName, JobType)
      WHERE JobType = 'decommission';
    END
  `);
}

async function getColumns(tableName) {
  const p = await getPool();
  const r = await p.request()
    .input("tableName", sql.NVarChar(128), tableName)
    .query(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA='dbo' AND TABLE_NAME=@tableName
    `);

  return new Set(r.recordset.map(x => String(x.COLUMN_NAME || "").toLowerCase()));
}

function pickInventoryColumns(cols) {
  const serverCandidates = ["sourceserver", "servername", "server_name", "server"];
  const dbCandidates = ["databasename", "dbname", "db_name", "database"];
  return {
    serverCol: serverCandidates.find(c => cols.has(c)),
    dbCol: dbCandidates.find(c => cols.has(c))
  };
}

async function fetchReports() {
  const p = await getPool();
  const r = await p.request().query(`
    SELECT
      JobId, JobType, Technology, SourceServer, DatabaseName, Environment, DevTestProd, DBVersion,
      ProjectRuby, RequestNo, AssignedTo, SoakStatus, DBSize, StorageReclaimed,
      Phase1Date, Phase2Date, TargetServer, NewDbName, Completed, HasError, StartedAt, CompletedAt, Comments
    FROM dbo.tb6r
    ORDER BY StartedAt DESC, Id DESC
  `);

  return r.recordset.map(x => ({
    jobId: x.JobId || "",
    type: x.JobType || "",
    technology: x.Technology || "",
    source: x.SourceServer || "",
    db: x.DatabaseName || "",
    environment: x.Environment || "",
    devTestProd: x.DevTestProd || "",
    dbVersion: x.DBVersion || "",
    projectRuby: x.ProjectRuby || "",
    requestNo: x.RequestNo || "",
    assignedTo: x.AssignedTo || "",
    soakStatus: x.SoakStatus || "",
    dbSize: x.DBSize || "",
    storageReclaimed: x.StorageReclaimed || "",
    phase1Date: x.Phase1Date || "",
    phase2Date: x.Phase2Date || "",
    target: x.TargetServer || "",
    newDbName: x.NewDbName || "",
    completed: !!x.Completed,
    error: !!x.HasError,
    startedAt: x.StartedAt ? new Date(x.StartedAt).toISOString() : "",
    completedAt: x.CompletedAt ? new Date(x.CompletedAt).toISOString() : "",
    comments: x.Comments || ""
  }));
}

// ---------------------- API ROUTES ----------------------

// GET /api/inventory
app.get("/api/inventory", async (req, res) => {
  try {
    await ensureTb6r();

    const cols = await getColumns("tb5r");
    const pick = pickInventoryColumns(cols);

    if (!pick.serverCol || !pick.dbCol) {
      return res.status(500).json({
        error: "Could not find server/database columns in dbo.tb5r"
      });
    }

    const p = await getPool();
    const inv = await p.request().query(`
      SELECT DISTINCT
        LTRIM(RTRIM(CAST([${pick.serverCol}] AS NVARCHAR(255)))) AS serverName,
        LTRIM(RTRIM(CAST([${pick.dbCol}] AS NVARCHAR(255)))) AS databaseName
      FROM dbo.tb5r
      WHERE LTRIM(RTRIM(CAST([${pick.serverCol}] AS NVARCHAR(255)))) <> ''
        AND LTRIM(RTRIM(CAST([${pick.dbCol}] AS NVARCHAR(255)))) <> ''
      ORDER BY serverName, databaseName
    `);

    return res.json(inv.recordset);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/jobs
app.get("/api/jobs", async (req, res) => {
  try {
    await ensureTb6r();
    const reports = await fetchReports();
    return res.json(reports);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// POST /api/jobs (upsert by JobId)
app.post("/api/jobs", async (req, res) => {
  try {
    await ensureTb6r();
    const payload = req.body || {};
    const p = await getPool();

    if (!safe(payload.jobId)) {
      return res.status(400).json({ error: "jobId is required" });
    }

    // For decommission, prevent duplicates by source+db
    if (safe(payload.type).toLowerCase() === "decommission") {
      const chk = await p.request()
        .input("SourceServer", sql.NVarChar(255), safe(payload.source))
        .input("DatabaseName", sql.NVarChar(255), safe(payload.db))
        .query(`
          SELECT TOP 1 JobId
          FROM dbo.tb6r
          WHERE LOWER(LTRIM(RTRIM(JobType)))='decommission'
            AND LOWER(LTRIM(RTRIM(SourceServer)))=LOWER(LTRIM(RTRIM(@SourceServer)))
            AND LOWER(LTRIM(RTRIM(DatabaseName)))=LOWER(LTRIM(RTRIM(@DatabaseName)))
        `);

      if (chk.recordset.length && chk.recordset[0].JobId !== safe(payload.jobId)) {
        return res.status(409).json({
          error: "A decommission entry already exists for this server+database"
        });
      }
    }

    await p.request()
      .input("JobId", sql.NVarChar(100), safe(payload.jobId))
      .input("JobType", sql.NVarChar(30), safe(payload.type))
      .input("Technology", sql.NVarChar(100), safe(payload.technology))
      .input("SourceServer", sql.NVarChar(255), safe(payload.source))
      .input("DatabaseName", sql.NVarChar(255), safe(payload.db))
      .input("Environment", sql.NVarChar(50), safe(payload.environment))
      .input("DevTestProd", sql.NVarChar(50), safe(payload.devTestProd))
      .input("DBVersion", sql.NVarChar(100), safe(payload.dbVersion))
      .input("ProjectRuby", sql.NVarChar(10), safe(payload.projectRuby))
      .input("RequestNo", sql.NVarChar(100), safe(payload.requestNo))
      .input("AssignedTo", sql.NVarChar(150), safe(payload.assignedTo))
      .input("SoakStatus", sql.NVarChar(50), safe(payload.soakStatus))
      .input("DBSize", sql.NVarChar(50), safe(payload.dbSize))
      .input("StorageReclaimed", sql.NVarChar(50), safe(payload.storageReclaimed))
      .input("Phase1Date", sql.NVarChar(30), safe(payload.phase1Date))
      .input("Phase2Date", sql.NVarChar(30), safe(payload.phase2Date))
      .input("TargetServer", sql.NVarChar(255), safe(payload.target))
      .input("NewDbName", sql.NVarChar(255), safe(payload.newDbName))
      .input("Completed", sql.Bit, !!payload.completed)
      .input("HasError", sql.Bit, !!payload.error)
      .input("StartedAt", sql.DateTime2, payload.startedAt ? new Date(payload.startedAt) : null)
      .input("CompletedAt", sql.DateTime2, payload.completedAt ? new Date(payload.completedAt) : null)
      .input("Comments", sql.NVarChar(sql.MAX), safe(payload.comments))
      .query(`
        MERGE dbo.tb6r AS t
        USING (SELECT @JobId AS JobId) AS s
        ON t.JobId = s.JobId
        WHEN MATCHED THEN UPDATE SET
          JobType=@JobType, Technology=@Technology, SourceServer=@SourceServer, DatabaseName=@DatabaseName,
          Environment=@Environment, DevTestProd=@DevTestProd, DBVersion=@DBVersion,
          ProjectRuby=@ProjectRuby, RequestNo=@RequestNo, AssignedTo=@AssignedTo, SoakStatus=@SoakStatus,
          DBSize=@DBSize, StorageReclaimed=@StorageReclaimed, Phase1Date=@Phase1Date, Phase2Date=@Phase2Date,
          TargetServer=@TargetServer, NewDbName=@NewDbName, Completed=@Completed, HasError=@HasError,
          StartedAt=@StartedAt, CompletedAt=@CompletedAt, Comments=@Comments
        WHEN NOT MATCHED THEN INSERT (
          JobId, JobType, Technology, SourceServer, DatabaseName, Environment, DevTestProd, DBVersion,
          ProjectRuby, RequestNo, AssignedTo, SoakStatus, DBSize, StorageReclaimed,
          Phase1Date, Phase2Date, TargetServer, NewDbName, Completed, HasError, StartedAt, CompletedAt, Comments
        ) VALUES (
          @JobId, @JobType, @Technology, @SourceServer, @DatabaseName, @Environment, @DevTestProd, @DBVersion,
          @ProjectRuby, @RequestNo, @AssignedTo, @SoakStatus, @DBSize, @StorageReclaimed,
          @Phase1Date, @Phase2Date, @TargetServer, @NewDbName, @Completed, @HasError, @StartedAt, @CompletedAt, @Comments
        );
      `);

    const reports = await fetchReports();
    return res.json({ success: true, reports });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// PATCH /api/jobs/soak
app.patch("/api/jobs/soak", async (req, res) => {
  try {
    await ensureTb6r();
    const payload = req.body || {};
    const source = safe(payload.source);
    const db = safe(payload.db);
    const soakStatus = safe(payload.soakStatus);

    if (!source || !db || !soakStatus) {
      return res.status(400).json({ error: "source, db and soakStatus are required" });
    }

    const p = await getPool();
    const result = await p.request()
      .input("SourceServer", sql.NVarChar(255), source)
      .input("DatabaseName", sql.NVarChar(255), db)
      .input("SoakStatus", sql.NVarChar(50), soakStatus)
      .query(`
        UPDATE dbo.tb6r
        SET
          SoakStatus=@SoakStatus,
          CompletedAt=SYSUTCDATETIME()
        WHERE LOWER(LTRIM(RTRIM(SourceServer)))=LOWER(LTRIM(RTRIM(@SourceServer)))
          AND LOWER(LTRIM(RTRIM(DatabaseName)))=LOWER(LTRIM(RTRIM(@DatabaseName)))
          AND LOWER(LTRIM(RTRIM(JobType)))='decommission';
      `);

    if (!result.rowsAffected || result.rowsAffected[0] === 0) {
      return res.status(404).json({
        error: "No matching decommission entry found for source+db"
      });
    }

    const reports = await fetchReports();
    return res.json({ ok: true, reports });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// DELETE /api/jobs
app.delete("/api/jobs", async (req, res) => {
  try {
    await ensureTb6r();
    const p = await getPool();
    await p.request().query(`DELETE FROM dbo.tb6r`);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ---------------------- SINGLE PAGE UI ----------------------
app.get("/", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>DB Migration & Decommission Tool</title>
  <script src="https://cdn.sheetjs.com/xlsx-0.20.2/package/dist/xlsx.full.min.js"></script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#0d1117;--panel:#161b22;--line:#30363d;--line2:#21262d;
      --text:#c9d1d9;--textStrong:#e6edf3;--muted:#8b949e;
      --blue:#58a6ff;--green:#3fb950;--red:#f85149;
    }
    body{font-family:"Segoe UI",Tahoma,Geneva,Verdana,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:28px 18px 36px}
    h1{font-size:1.5rem;color:var(--blue);margin-bottom:6px;text-align:center;letter-spacing:1px}
    .subtitle{font-size:.85rem;color:var(--muted);margin-bottom:18px;text-align:center}
    .top-actions,.mode-bar,.stats,.card,.jobs-section{width:100%;max-width:1060px}
    .top-actions{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-bottom:16px}
    .btn{border:1px solid var(--line);background:var(--panel);color:var(--text);padding:10px 14px;border-radius:10px;cursor:pointer;font-weight:700;font-size:.88rem;transition:.2s}
    .btn:hover{border-color:var(--blue);color:var(--blue)}
    .btn-primary{background:var(--blue);border-color:var(--blue);color:#fff}.btn-primary:hover{color:#fff;filter:brightness(1.06)}
    .btn-danger{background:var(--red);border-color:var(--red);color:#fff}.btn-danger:hover{color:#fff;filter:brightness(1.06)}
    .mode-bar{display:flex;gap:10px;margin-bottom:14px}
    .mode-btn{flex:1;padding:13px 20px;font-size:.98rem;font-weight:800;letter-spacing:1.2px;border:2px solid transparent;border-radius:10px;cursor:pointer;transition:all .25s;background:var(--panel);color:var(--muted)}
    .mode-btn.decom{border-color:var(--red)} .mode-btn.decom.active{background:var(--red);color:#fff;box-shadow:0 0 16px #f8514966}
    .mode-btn.migr{border-color:var(--green)} .mode-btn.migr.active{background:var(--green);color:#fff;box-shadow:0 0 16px #3fb95066}
    .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:12px}
    .stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:11px}
    .stat .label{color:var(--muted);font-size:.72rem;margin-bottom:6px;text-transform:uppercase;letter-spacing:.8px}
    .stat .value{font-size:1.2rem;font-weight:800;color:var(--textStrong)}
    .chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
    .chip{padding:6px 10px;border:1px solid var(--line);background:var(--panel);border-radius:999px;font-size:.76rem;color:var(--text)}
    .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:13px}
    .card-header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}
    .badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:.75rem;font-weight:700;letter-spacing:1px}
    .badge.decom{background:#f8514922;color:var(--red);border:1px solid #f8514944}
    .badge.migr{background:#3fb95022;color:var(--green);border:1px solid #3fb95044}
    .card-title{font-size:1.02rem;font-weight:700;color:var(--textStrong)}
    .field-help{color:var(--muted);font-size:.79rem;line-height:1.45;margin-top:5px}
    .form-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:11px}
    .full{grid-column:1/-1}
    label{display:block;margin-bottom:6px;color:var(--muted);font-size:.81rem;font-weight:700;letter-spacing:.4px}
    input[type="text"],input[type="date"],textarea,select{width:100%;background:var(--bg);border:1px solid var(--line);color:var(--text);padding:10px 12px;border-radius:8px;font-size:.9rem;outline:none;transition:border-color .2s}
    input:focus,textarea:focus,select:focus{border-color:var(--blue)} textarea{min-height:88px;resize:vertical}
    .status-panel{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:13px;margin-top:14px;margin-bottom:13px;min-height:85px}
    .status-label{font-size:.75rem;color:var(--muted);margin-bottom:7px;font-weight:700;letter-spacing:.8px}
    .status-text{font-size:.9rem;color:var(--blue);font-family:Consolas,monospace;word-break:break-word}
    .status-text.error{color:var(--red)} .status-text.success{color:var(--green)}
    .run-btn{width:100%;padding:12px;font-size:.96rem;font-weight:800;border:none;border-radius:10px;cursor:pointer;transition:.25s;letter-spacing:.7px}
    .run-btn.decom{background:var(--red);color:#fff}.run-btn.decom:hover:not(:disabled){background:#da3633;box-shadow:0 0 14px #f8514966}
    .run-btn.migr{background:var(--green);color:#fff}.run-btn.migr:hover:not(:disabled){background:#2ea043;box-shadow:0 0 14px #3fb95066}
    .run-btn:disabled{opacity:.45;cursor:not-allowed}
    .status-editor{margin-top:14px;border:1px solid #58a6ff44;background:#58a6ff12;border-radius:10px;padding:12px}
    .status-editor p{color:var(--muted);font-size:.79rem;margin-bottom:11px;line-height:1.42}
    .status-note{margin-top:9px;font-size:.8rem;color:var(--muted)}
    .status-note.success{color:var(--green)} .status-note.error{color:var(--red)}
    .jobs-section{margin-top:4px}
    .jobs-title{font-size:.84rem;color:var(--muted);font-weight:700;letter-spacing:1px;margin-bottom:9px;text-transform:uppercase}
    .table-wrap{overflow:auto;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
    table{width:100%;min-width:1700px;border-collapse:collapse;font-size:.81rem}
    thead th{text-align:left;padding:8px 10px;color:var(--muted);border-bottom:1px solid var(--line2);font-weight:600;background:#111821;position:sticky;top:0;white-space:nowrap}
    tbody tr{border-bottom:1px solid var(--line2)} tbody tr:hover{background:#111821}
    tbody td{padding:8px 10px;white-space:nowrap}
    .pill{display:inline-block;padding:2px 9px;border-radius:12px;font-size:.72rem;font-weight:700}
    .pill.migr{background:#3fb95022;color:var(--green);border:1px solid #3fb95044}
    .pill.decom{background:#f8514922;color:var(--red);border:1px solid #f8514944}
    .pill.ok{background:#3fb95022;color:var(--green)}
    .pill.err{background:#f8514922;color:var(--red)}
    .pill.run{background:#58a6ff22;color:var(--blue)}
    .hidden{display:none!important}
    @media (max-width:980px){.stats{grid-template-columns:repeat(2,1fr)}.form-grid{grid-template-columns:repeat(2,1fr)}}
    @media (max-width:700px){.mode-bar{flex-direction:column}.stats{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.btn,.run-btn{width:100%}.top-actions{flex-direction:column}}
  </style>
</head>
<body>
  <h1>DB MIGRATION &amp; DECOMMISSION TOOL</h1>
  <p class="subtitle">Step 1 inventory auto-load from SQL Server: dbo.tb5r</p>

  <div class="top-actions">
    <button class="btn" onclick="exportToXLSX()">Export Report (.xlsx)</button>
    <button class="btn" onclick="exportToCSV()">Export CSV</button>
    <button class="btn btn-danger" onclick="clearJobs()">Clear History</button>
  </div>

  <div class="mode-bar">
    <button class="mode-btn decom active" id="modeBtnDecom" onclick="setMode('decom')">DECOM</button>
    <button class="mode-btn migr" id="modeBtnMigr" onclick="setMode('migr')">MIGR8</button>
  </div>

  <div class="stats">
    <div class="stat"><div class="label">Inventory Rows</div><div class="value" id="statRows">0</div></div>
    <div class="stat"><div class="label">Servers</div><div class="value" id="statServers">0</div></div>
    <div class="stat"><div class="label">Databases</div><div class="value" id="statDatabases">0</div></div>
    <div class="stat"><div class="label">Jobs Logged</div><div class="value" id="statJobs">0</div></div>
  </div>

  <div class="card">
    <div class="card-header">
      <span id="modeBadge" class="badge decom">DECOMMISSION</span>
      <span class="card-title">Step 1: Inventory From Server</span>
    </div>
    <div class="field-help">Upload is disabled. Source is SQL server table dbo.tb5r.</div>
    <div class="chips" id="inventorySummary"></div>
  </div>

  <div class="card">
    <div class="card-header">
      <span id="modeBadge2" class="badge decom">DECOMMISSION</span>
      <span class="card-title">Step 2: Request Details</span>
    </div>

    <div class="form-grid">
      <div><label for="technology">Technology</label>
        <select id="technology">
          <option value="">Select Technology</option><option>SQL Server</option><option>Oracle</option><option>PostgreSQL</option><option>MySQL</option>
        </select>
      </div>
      <div><label for="sourceServer">Server Name</label><input type="text" id="sourceServer" list="serversList" placeholder="Type server name" autocomplete="off"/></div>
      <div><label for="dbName">Database Name</label><input type="text" id="dbName" list="dbList" placeholder="Type database name" autocomplete="off"/></div>
      <div><label for="environment">Environment</label><select id="environment"><option value="">Select Environment</option><option>Dev</option><option>Test</option><option>Prod</option></select></div>
      <div><label for="devTestProd">Dev / Test / Prod</label><select id="devTestProd"><option value="">Select</option><option>Dev</option><option>Test</option><option>Prod</option></select></div>
      <div><label for="dbVersion">DB Version</label><input type="text" id="dbVersion" placeholder="e.g. SQL Server 2019"/></div>
      <div><label for="projectRuby">Part of Project Ruby</label><select id="projectRuby"><option value="">Select</option><option>Yes</option><option>No</option></select></div>
      <div><label for="requestNo">Request / GCR No</label><input type="text" id="requestNo" placeholder="Request or change number"/></div>
      <div><label for="assignedTo">Assigned To</label><input type="text" id="assignedTo" placeholder="Owner / engineer name"/></div>
      <div><label for="soakStatus">Soak Period Status</label><select id="soakStatus"><option value="">Select Status</option><option>Offline</option><option>Drop</option><option>In soak period</option><option>Completed</option></select></div>
      <div><label for="dbSize">DB Size</label><input type="text" id="dbSize" placeholder="e.g. 450 GB"/></div>
      <div><label for="storageReclaimed">Storage Reclaimed</label><input type="text" id="storageReclaimed" placeholder="e.g. 500 GB"/></div>
      <div><label for="phase1Date">Phase 1 Completion Date</label><input type="date" id="phase1Date"/></div>
      <div><label for="phase2Date">Phase 2 Completion Date</label><input type="date" id="phase2Date"/></div>

      <div id="migrationFields" class="full hidden">
        <div class="form-grid">
          <div><label for="targetServer">Target Server</label><input type="text" id="targetServer" placeholder="Target server"/></div>
          <div><label for="newDbName">New DB Name (optional)</label><input type="text" id="newDbName" placeholder="Use source DB name if blank"/></div>
        </div>
      </div>

      <div class="full"><label for="comments">Comments</label><textarea id="comments" placeholder="Operational notes, approvals, closure remarks"></textarea></div>
    </div>

    <datalist id="serversList"></datalist>
    <datalist id="dbList"></datalist>

    <div class="status-panel">
      <div class="status-label">STATUS</div>
      <div class="status-text" id="statusText">Initializing...</div>
    </div>

    <button class="run-btn decom" id="runBtn" onclick="runAction()">RUN DECOMMISSION</button>

    <div class="status-editor">
      <p>Update only Soak Period Status for existing decommission entry (exact Server + Database match required).</p>
      <div class="form-grid">
        <div><label for="statusOnlyServer">Server Name</label><input type="text" id="statusOnlyServer" list="serversList" placeholder="Type existing server" autocomplete="off"/></div>
        <div><label for="statusOnlyDb">Database Name</label><input type="text" id="statusOnlyDb" list="dbList" placeholder="Type existing database" autocomplete="off"/></div>
        <div><label for="statusOnlyValue">New Soak Status</label><select id="statusOnlyValue"><option value="">Select Status</option><option>Offline</option><option>Drop</option><option>In soak period</option><option>Completed</option></select></div>
        <div><label>&nbsp;</label><button class="btn btn-primary" style="width:100%" onclick="updateSoakStatusOnly()">Update Status</button></div>
      </div>
      <div id="statusOnlyMessage" class="status-note"></div>
    </div>
  </div>

  <div class="jobs-section">
    <div class="jobs-title">Job History &amp; Report Register</div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Type</th><th>Technology</th><th>Source</th><th>Database</th><th>Environment</th><th>Dev/Test/Prod</th><th>DB Version</th><th>Project Ruby</th><th>Request/GCR No</th><th>Assigned To</th><th>Soak Status</th><th>DB Size</th><th>Storage Reclaimed</th><th>Phase1</th><th>Phase2</th><th>Target</th><th>New DB Name</th><th>Status</th><th>Started</th><th>Completed</th><th>Comments</th>
        </tr></thead>
        <tbody id="jobsBody"><tr><td colspan="21" style="color:#8b949e;text-align:center;padding:18px;">No jobs yet.</td></tr></tbody>
      </table>
    </div>
  </div>

<script>
const API_BASE = "";
let currentMode = "decom", allJobs = [], inventoryData = [], inventoryMap = {}, allServers = [], allDatabases = [];

const cleanCell = v => String(v ?? "").replace(/\\u00A0/g, " ").trim();
const escapeHtml = v => String(v ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
const uniqSorted = vals => [...new Set(vals.filter(Boolean))].sort((a,b)=>a.localeCompare(b));

function setStatus(msg, cls){const el=document.getElementById("statusText");el.textContent=msg;el.className="status-text "+(cls||"");}
function formatDateTime(v){if(!v) return "-"; return new Date(v).toLocaleString();}
function formatDateOnly(v){if(!v) return ""; const d=new Date(v); if(Number.isNaN(d.getTime())) return v; return String(d.getMonth()+1).padStart(2,"0")+"/"+String(d.getDate()).padStart(2,"0")+"/"+d.getFullYear();}

function buildInventoryMap(rows){
  const map={}; rows.forEach(r=>{if(!map[r.serverName]) map[r.serverName]=[]; if(!map[r.serverName].includes(r.databaseName)) map[r.serverName].push(r.databaseName);});
  Object.keys(map).forEach(s=>map[s].sort((a,b)=>a.localeCompare(b)));
  return map;
}

function updateSummaryCards(){
  document.getElementById("statRows").textContent=inventoryData.length;
  document.getElementById("statServers").textContent=allServers.length;
  document.getElementById("statDatabases").textContent=allDatabases.length;
  document.getElementById("statJobs").textContent=allJobs.length;
  const chips=["Source: dbo.tb5r","Mapped rows: "+inventoryData.length,"Mode: "+(currentMode==="decom"?"Decommission":"Migration")];
  document.getElementById("inventorySummary").innerHTML=chips.map(t=>'<span class="chip">'+escapeHtml(t)+"</span>").join("");
}

function bindDatalists(){
  const serversList=document.getElementById("serversList"), dbList=document.getElementById("dbList");
  serversList.innerHTML=allServers.map(s=>'<option value="'+escapeHtml(s)+'"></option>').join("");
  dbList.innerHTML=allDatabases.map(d=>'<option value="'+escapeHtml(d)+'"></option>').join("");
  document.getElementById("sourceServer").addEventListener("input",e=>{
    const server=cleanCell(e.target.value); const scoped=inventoryMap[server]||allDatabases;
    dbList.innerHTML=scoped.map(d=>'<option value="'+escapeHtml(d)+'"></option>').join("");
  });
}

async function apiCall(path, options={}){
  const res=await fetch(API_BASE+path,{headers:{"Content-Type":"application/json",...(options.headers||{})},...options});
  let data=null; try{data=await res.json();}catch{data=null;}
  if(!res.ok) throw new Error((data&&data.error)?data.error:"API request failed: "+path);
  return data;
}

async function loadInventoryFromServer(){
  const rows=await apiCall("/api/inventory");
  inventoryData=rows.map(r=>({serverName:cleanCell(r.serverName),databaseName:cleanCell(r.databaseName)})).filter(r=>r.serverName&&r.databaseName);
  inventoryMap=buildInventoryMap(inventoryData);
  allServers=uniqSorted(inventoryData.map(r=>r.serverName));
  allDatabases=uniqSorted(inventoryData.map(r=>r.databaseName));
  bindDatalists(); updateSummaryCards();
  setStatus("Step 1 loaded from SQL Server dbo.tb5r.", "success");
}
async function loadJobs(){allJobs=await apiCall("/api/jobs"); refreshJobs();}
async function saveJob(job){await apiCall("/api/jobs",{method:"POST",body:JSON.stringify(job)});}

function setMode(mode){
  currentMode=mode;
  document.getElementById("modeBtnDecom").classList.toggle("active",mode==="decom");
  document.getElementById("modeBtnMigr").classList.toggle("active",mode==="migr");
  const badge=document.getElementById("modeBadge"), badge2=document.getElementById("modeBadge2"), runBtn=document.getElementById("runBtn");
  if(mode==="decom"){
    badge.className="badge decom"; badge.textContent="DECOMMISSION";
    badge2.className="badge decom"; badge2.textContent="DECOMMISSION";
    runBtn.className="run-btn decom"; runBtn.textContent="RUN DECOMMISSION";
    document.getElementById("migrationFields").classList.add("hidden");
  }else{
    badge.className="badge migr"; badge.textContent="MIGRATION";
    badge2.className="badge migr"; badge2.textContent="MIGRATION";
    runBtn.className="run-btn migr"; runBtn.textContent="START MIGRATION";
    document.getElementById("migrationFields").classList.remove("hidden");
  }
  updateSummaryCards();
}

function validateForm(){
  const technology=cleanCell(document.getElementById("technology").value);
  const sourceServer=cleanCell(document.getElementById("sourceServer").value);
  const dbName=cleanCell(document.getElementById("dbName").value);
  if(!inventoryData.length) return alert("Inventory could not be loaded from server."),false;
  if(!technology) return alert("Please select Technology."),false;
  if(!sourceServer) return alert("Enter Server Name."),false;
  if(!dbName) return alert("Enter Database Name."),false;
  if(!inventoryMap[sourceServer]) return alert("Server Name not found in server-loaded inventory."),false;
  if(!(inventoryMap[sourceServer]||[]).includes(dbName)) return alert("Database Name is not mapped to selected Server Name."),false;
  if(currentMode==="decom"){
    if(!document.getElementById("environment").value) return alert("Select Environment."),false;
    if(!document.getElementById("devTestProd").value) return alert("Select Dev/Test/Prod."),false;
  }
  if(currentMode==="migr"){
    const target=cleanCell(document.getElementById("targetServer").value);
    if(!target) return alert("Enter Target Server."),false;
    if(sourceServer.toLowerCase()===target.toLowerCase()) return alert("Source and Target cannot be same."),false;
  }
  return true;
}

const generateJobId=()=> "JOB-"+Date.now()+"-"+Math.floor(Math.random()*1000);

function createJob(){
  const source=cleanCell(document.getElementById("sourceServer").value);
  const db=cleanCell(document.getElementById("dbName").value);
  const target=cleanCell(document.getElementById("targetServer").value);
  const newDbNameInput=cleanCell(document.getElementById("newDbName").value);
  const newDbName=currentMode==="migr"?(newDbNameInput||db):"";
  return {
    jobId:generateJobId(),
    type:currentMode==="migr"?"migration":"decommission",
    technology:document.getElementById("technology").value,
    source, db,
    environment:document.getElementById("environment").value,
    devTestProd:document.getElementById("devTestProd").value,
    dbVersion:cleanCell(document.getElementById("dbVersion").value),
    projectRuby:document.getElementById("projectRuby").value,
    requestNo:cleanCell(document.getElementById("requestNo").value),
    assignedTo:cleanCell(document.getElementById("assignedTo").value),
    soakStatus:document.getElementById("soakStatus").value,
    dbSize:cleanCell(document.getElementById("dbSize").value),
    storageReclaimed:cleanCell(document.getElementById("storageReclaimed").value),
    phase1Date:document.getElementById("phase1Date").value,
    phase2Date:document.getElementById("phase2Date").value,
    comments:cleanCell(document.getElementById("comments").value),
    target:currentMode==="migr"?target:"",
    newDbName,
    completed:true,error:false,
    startedAt:new Date().toISOString(),
    completedAt:new Date().toISOString()
  };
}

function refreshJobs(){
  const tbody=document.getElementById("jobsBody");
  if(!allJobs.length){
    tbody.innerHTML='<tr><td colspan="21" style="color:#8b949e;text-align:center;padding:18px;">No jobs yet.</td></tr>';
    updateSummaryCards(); return;
  }
  tbody.innerHTML=allJobs.slice().reverse().map(j=>{
    const typeClass=j.type==="migration"?"migr":"decom", typeLabel=j.type==="migration"?"MIGR8":"DECOM";
    const stClass=j.error?"err":(j.completed?"ok":"run"), stLabel=j.error?"Error":(j.completed?"Done":"Running");
    return "<tr>"+
      '<td><span class="pill '+typeClass+'">'+typeLabel+"</span></td>"+
      "<td>"+escapeHtml(j.technology||"-")+"</td><td>"+escapeHtml(j.source||"-")+"</td><td>"+escapeHtml(j.db||"-")+"</td><td>"+escapeHtml(j.environment||"-")+"</td><td>"+escapeHtml(j.devTestProd||"-")+"</td><td>"+escapeHtml(j.dbVersion||"-")+"</td><td>"+escapeHtml(j.projectRuby||"-")+"</td><td>"+escapeHtml(j.requestNo||"-")+"</td><td>"+escapeHtml(j.assignedTo||"-")+"</td><td>"+escapeHtml(j.soakStatus||"-")+"</td><td>"+escapeHtml(j.dbSize||"-")+"</td><td>"+escapeHtml(j.storageReclaimed||"-")+"</td><td>"+escapeHtml(formatDateOnly(j.phase1Date)||"-")+"</td><td>"+escapeHtml(formatDateOnly(j.phase2Date)||"-")+"</td><td>"+escapeHtml(j.target||"-")+"</td><td>"+escapeHtml(j.newDbName||"-")+"</td>"+
      '<td><span class="pill '+stClass+'">'+stLabel+"</span></td>"+
      "<td>"+escapeHtml(formatDateTime(j.startedAt))+"</td><td>"+escapeHtml(formatDateTime(j.completedAt))+"</td><td>"+escapeHtml(j.comments||"-")+"</td>"+
    "</tr>";
  }).join("");
  updateSummaryCards();
}

async function runAction(){
  try{
    if(!validateForm()) return;
    const job=createJob();
    document.getElementById("runBtn").disabled=true;
    setStatus("Saving to server...", "");
    await saveJob(job);
    await loadJobs();
    setStatus(job.type==="migration"?"Migration saved successfully.":"Decommission saved successfully.","success");
  }catch(err){
    setStatus(err.message||"Operation failed.","error");
  }finally{
    document.getElementById("runBtn").disabled=false;
  }
}

function setStatusOnlyMessage(msg,type=""){const el=document.getElementById("statusOnlyMessage");el.textContent=msg;el.className="status-note "+type;}

async function updateSoakStatusOnly(){
  const server=cleanCell(document.getElementById("statusOnlyServer").value);
  const db=cleanCell(document.getElementById("statusOnlyDb").value);
  const newStatus=cleanCell(document.getElementById("statusOnlyValue").value);
  if(!server||!db||!newStatus){setStatusOnlyMessage("Please enter server, database, and new status.","error");return;}
  try{
    await apiCall("/api/jobs/soak",{method:"PATCH",body:JSON.stringify({source:server,db,soakStatus:newStatus})});
    await loadJobs();
    setStatusOnlyMessage("Soak status updated successfully.","success");
    setStatus("Status update saved to server.","success");
  }catch(err){
    setStatusOnlyMessage(err.message||"Update failed.","error");
  }
}

const csvEscape=v => '"' + String(v ?? "").replace(/"/g,'""') + '"';

function getExportRows(){
  return allJobs.map(j=>({
    "Type":j.type,"Technology":j.technology,"Server Name":j.source,"Database Name":j.db,"Environment":j.environment,
    "Dev/Test/Prod":j.devTestProd,"DB Version":j.dbVersion,"Part of Project Ruby(Yes/No)":j.projectRuby,
    "Request/GCR No":j.requestNo,"Assigned To":j.assignedTo,"Soak Period status":j.soakStatus,
    "DB size (MB/GB/TB)":j.dbSize,"Storage Reclaimed (MB/GB/TB)":j.storageReclaimed,
    "Phase1 Completion Date (MM/DD/YYYY)":formatDateOnly(j.phase1Date),
    "Phase2 Completion Date (MM/DD/YYYY)":formatDateOnly(j.phase2Date),
    "Target Server":j.target,"New DB Name":j.newDbName,
    "Status":j.error?"Error":(j.completed?"Completed":"Running"),
    "Started":formatDateTime(j.startedAt),"Completed":formatDateTime(j.completedAt),"Comments":j.comments
  }));
}

function exportToCSV(){
  if(!allJobs.length) return alert("No jobs available to export.");
  const rows=getExportRows(), headers=Object.keys(rows[0]);
  const csv=[headers,...rows.map(r=>headers.map(h=>r[h]))].map(row=>row.map(csvEscape).join(",")).join("\\n");
  const blob=new Blob([csv],{type:"text/csv;charset=utf-8;"}), url=URL.createObjectURL(blob), link=document.createElement("a");
  link.href=url; link.download="db_report.csv"; document.body.appendChild(link); link.click(); document.body.removeChild(link); URL.revokeObjectURL(url);
}

function exportToXLSX(){
  if(!allJobs.length) return alert("No jobs available to export.");
  const rows=getExportRows(), ws=XLSX.utils.json_to_sheet(rows);
  ws["!cols"]=[{wch:12},{wch:15},{wch:18},{wch:18},{wch:14},{wch:14},{wch:16},{wch:16},{wch:16},{wch:14},{wch:16},{wch:16},{wch:18},{wch:18},{wch:18},{wch:16},{wch:16},{wch:12},{wch:20},{wch:20},{wch:30}];
  const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,"dbr1"); XLSX.writeFile(wb,"db_report.xlsx");
}

async function clearJobs(){
  if(!confirm("Are you sure you want to clear all job history?")) return;
  try{
    await apiCall("/api/jobs",{method:"DELETE"});
    allJobs=[]; refreshJobs(); setStatusOnlyMessage(""); setStatus("History cleared from server.","success");
  }catch(err){
    setStatus(err.message||"Failed to clear history.","error");
  }
}

async function init(){
  setMode("decom");
  setStatus("Loading inventory and jobs from server...", "");
  try{
    await loadInventoryFromServer();
    await loadJobs();
    setStatus("Ready. Inventory and reports loaded from SQL Server.","success");
  }catch(error){
    setStatus(error.message||"Initialization failed.","error");
  }
}
init();
</script>
</body></html>`);
});

// ---------------------- START ----------------------
app.listen(PORT, async () => {
  try {
    await ensureTb6r();
    console.log("Server started at http://localhost:" + PORT);
  } catch (e) {
    console.error("Startup error:", e.message);
  }
});