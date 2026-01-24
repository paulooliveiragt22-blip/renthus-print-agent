// printAgent.advanced.js (UPDATED)
// Node 16+
// Run: node printAgent.advanced.js
/* eslint-disable no-console */

const net = require("net");
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

let fetchFn = null;

// Try to use global fetch (Node 18+). Otherwise use node-fetch.
try {
    if (typeof fetch === "function") {
        fetchFn = fetch.bind(global);
    } else {
        fetchFn = require("node-fetch");
    }
} catch (e) {
    try {
        fetchFn = require("node-fetch");
    } catch (err) {
        console.error("Please install 'node-fetch' or run on Node 18+ (with global fetch).", err.message);
        process.exit(1);
    }
}

// Optional hardware libraries (best-effort)
let escpos = null;
let escposUsb = null;
let BluetoothSerialPort = null;
try {
    escpos = require("escpos");
    escposUsb = require("escpos-usb");
} catch (e) {
    console.warn("escpos libs not installed (USB printing won't be available) —", e.message);
}
try {
    BluetoothSerialPort = require("bluetooth-serial-port").BluetoothSerialPort;
} catch (e) {
    console.warn("bluetooth-serial-port not installed (Bluetooth printing won't be available) —", e.message);
}

// CONFIG
const API_BASE = (process.env.API_BASE || "http://localhost:3000/api/print").replace(/\/+$/, "");
let AGENT_KEY = process.env.AGENT_KEY || "";
const AGENT_PORT = Number(process.env.AGENT_PORT || 4001);
const DEFAULT_PRINTER_CONFIG_PATH = path.resolve(
    process.cwd(),
    process.env.DEFAULT_PRINTER_CONFIG_PATH || "printers.json"
);
const ALLOWED_FRONTEND_ORIGIN = process.env.NEXT_PUBLIC_BASE_URL || ""; // used for local printers CORS

// If AGENT_KEY is not set in the environment, try to load a local agent.env file
if (!AGENT_KEY) {
    try {
        const envPath = path.join(process.cwd(), "agent.env");
        if (fs.existsSync(envPath)) {
            const envText = fs.readFileSync(envPath, "utf8");
            envText.split(/\r?\n/).forEach((line) => {
                if (!line || !line.trim() || line.trim().startsWith("#")) return;
                const m = line.match(/^\s*([^=]+?)\s*=\s*(.*)\s*$/);
                if (m) {
                    const key = m[1].trim();
                    let val = m[2].trim();
                    if (
                        (val.startsWith('"') && val.endsWith('"')) ||
                        (val.startsWith("'") && val.endsWith("'"))
                    ) {
                        val = val.slice(1, -1);
                    }
                    process.env[key] = val;
                }
            });
            AGENT_KEY = process.env.AGENT_KEY || AGENT_KEY;
        }
    } catch (e) {
        console.warn("Could not read agent.env:", e && e.message ? e.message : e);
    }
}

if (!AGENT_KEY) {
    console.error("Please set AGENT_KEY environment variable (agent API key).");
    process.exit(1);
}

// In-memory structures
const companyQueues = new Map(); // companyId => { processing: Set(jobId) }
const printedCache = new Set(); // optional local set of printed order ids

// keep last printed times per printerId
const lastPrintedAt = new Map(); // printerId => timestamp ms

// Helper: fetch with Authorization
async function apiFetch(route, opts = {}) {
    const headers = Object.assign({}, opts.headers || {}, {
        Authorization: `Bearer ${AGENT_KEY}`,
    });
    const url = route.startsWith("http") ? route : `${API_BASE}${route.startsWith("/") ? "" : "/"}${route}`;
    const res = await fetchFn(url, Object.assign({}, opts, { headers }));
    return res;
}

// ---- Printing helpers ---- //

function buildReceiptBuffer(order, items) {
    const lines = [];
    const esc = (s) => Buffer.from(String(s || ""), "latin1");

    // init
    lines.push(Buffer.from([0x1b, 0x40])); // ESC @

    // center store name bold
    lines.push(Buffer.from([0x1b, 0x61, 1])); // center
    lines.push(Buffer.from([0x1b, 0x45, 1])); // bold
    lines.push(esc((order.company_name || "Renthus Service") + "\n"));
    lines.push(Buffer.from([0x1b, 0x45, 0])); // bold off
    lines.push(Buffer.from([0x1b, 0x61, 0])); // left
    lines.push(esc("--------------------------------\n"));

    const created = order.created_at ? new Date(order.created_at).toLocaleString() : new Date().toLocaleString();
    lines.push(esc(`Pedido: ${order.id}\n`));
    lines.push(esc(`Data: ${created}\n`));
    if (order.customer_name || order.customer_phone) {
        lines.push(esc(`Cliente: ${order.customer_name || ""}\n`));
        lines.push(esc(`Tel: ${order.customer_phone || ""}\n`));
    }
    if (order.delivery_address) lines.push(esc(`End: ${order.delivery_address}\n`));
    lines.push(esc("--------------------------------\n"));

    // items header
    lines.push(esc("ITEM                QTY   R$\n"));
    lines.push(esc("--------------------------------\n"));
    (items || []).forEach((it) => {
        const name = (it.product_name || it.name || "").substring(0, 16).padEnd(16, " ");
        const qty = String(it.quantity || it.qty || 1).padStart(3, " ");
        const price = Number(it.unit_price || it.price || 0).toFixed(2).padStart(6, " ");
        lines.push(esc(`${name}${qty} ${price}\n`));
    });
    lines.push(esc("--------------------------------\n"));

    // totals
    lines.push(Buffer.from([0x1b, 0x45, 1]));
    lines.push(esc(`TOTAL: R$ ${Number(order.total_amount || order.total || 0).toFixed(2)}\n`));
    lines.push(Buffer.from([0x1b, 0x45, 0]));
    lines.push(esc("\n"));

    // footer and cut
    lines.push(esc("Obrigado!\n\n\n"));
    lines.push(Buffer.from([0x1d, 0x56, 0x41, 0x10])); // GS V 1 partial cut

    return Buffer.concat(lines);
}

function buildA4PdfPath(order, items) {
    return new Promise((resolve, reject) => {
        const filename = `order_${order.id}_${Date.now()}.pdf`;
        const filepath = path.join(process.cwd(), "tmp", filename);
        fs.mkdirSync(path.dirname(filepath), { recursive: true });

        const doc = new PDFDocument({ size: "A4", margin: 40 });
        const stream = fs.createWriteStream(filepath);
        doc.pipe(stream);

        doc.fontSize(16).text(order.company_name || "Renthus Service", { align: "center" });
        doc.moveDown();
        doc.fontSize(10).text(`Pedido: ${order.id}`);
        doc.text(`Data: ${order.created_at || new Date().toISOString()}`);
        if (order.customer_name) doc.text(`Cliente: ${order.customer_name}`);
        if (order.customer_phone) doc.text(`Telefone: ${order.customer_phone}`);
        if (order.delivery_address) doc.text(`Endereço: ${order.delivery_address}`);
        doc.moveDown();

        doc.fontSize(11).text("Itens:");
        doc.moveDown(0.5);

        const itemLines = items || [];
        itemLines.forEach((it) => {
            doc.text(
                `${it.product_name || it.name || "(produto)"} x${it.quantity || it.qty || 1}  R$ ${Number(
                    it.unit_price || it.price || 0
                ).toFixed(2)}`
            );
        });

        doc.moveDown();
        doc.fontSize(12).text(`Total: R$ ${Number(order.total_amount || order.total || 0).toFixed(2)}`, {
            align: "right",
        });

        doc.end();
        stream.on("finish", () => resolve(filepath));
        stream.on("error", (e) => reject(e));
    });
}

function printTcp(buffer, host, port = 9100) {
    return new Promise((resolve, reject) => {
        const client = new net.Socket();
        client.setTimeout(7000);
        client.on("error", (err) => {
            client.destroy();
            reject(err);
        });
        client.connect(port, host, () => {
            client.write(buffer);
            client.end();
        });
        client.on("close", () => resolve());
        client.on("timeout", () => {
            client.destroy();
            reject(new Error("TCP print timeout"));
        });
    });
}

async function printUsb(buffer, usbVendorId, usbProductId) {
    if (!escpos || !escposUsb) throw new Error("escpos or escpos-usb not installed");
    const device = new escposUsb(usbVendorId, usbProductId);
    const printer = new escpos.Printer(new escpos.Device(device));
    return new Promise((resolve, reject) => {
        device.open((err) => {
            if (err) return reject(err);
            try {
                printer.raw(buffer);
            } catch (err2) {
                // ignore
            }
            setTimeout(() => {
                try {
                    device.close();
                } catch (e) { }
                resolve();
            }, 200);
        });
    });
}

async function printBluetooth(buffer, address, channel = 1) {
    if (!BluetoothSerialPort) throw new Error("bluetooth-serial-port not installed");
    return new Promise((resolve, reject) => {
        const bt = new BluetoothSerialPort();
        bt.connect(
            address,
            channel,
            () => {
                bt.write(buffer, (err) => {
                    if (err) {
                        bt.close();
                        return reject(err);
                    }
                    setTimeout(() => {
                        try {
                            bt.close();
                        } catch { }
                        resolve();
                    }, 200);
                });
            },
            (err) => reject(err || new Error("BT connect error"))
        );
    });
}

async function printPdfA4(filepath, options = {}) {
    const { print } = require("pdf-to-printer");
    const opts = {};
    if (options && options.printer) opts.printer = options.printer;
    return print(filepath, opts);
}

// ---- Helpers to obtain printer configs ---- //

async function getPrintersFromFile(companyId) {
    try {
        if (fs.existsSync(DEFAULT_PRINTER_CONFIG_PATH)) {
            const arr = JSON.parse(fs.readFileSync(DEFAULT_PRINTER_CONFIG_PATH, "utf-8"));
            return arr
                .filter((p) => p.company_id === companyId && p.is_active !== false)
                .map((p) => ({
                    id: p.id,
                    name: p.name,
                    type: p.type,
                    format: p.format,
                    autoPrint: p.autoPrint ?? p.auto_print ?? false,
                    intervalSeconds: p.intervalSeconds || p.interval_seconds || 0,
                    is_default: p.is_default ?? p.isDefault ?? false, // ✅ IMPORTANT: keep default flag
                    config: p.config || p,
                }));
        }
    } catch (e) {
        console.warn("Printers file error", e.message);
    }
    return [];
}

async function getPrinterFromBackend(printerId) {
    try {
        const res = await apiFetch(`/printers/${printerId}`);
        if (!res.ok) {
            console.warn("GET /printers/:id failed", res.status);
            return null;
        }
        const json = await res.json();
        return json.printer || json || null;
    } catch (e) {
        console.warn("Error fetching printer from backend:", e.message);
        return null;
    }
}

async function getPrintersForCompany(companyId) {
    // 1) try backend
    try {
        const res = await apiFetch(`/companies/${companyId}/printers`);
        if (res.ok) {
            const json = await res.json();
            const arr = Array.isArray(json.printers)
                ? json.printers
                : Array.isArray(json)
                    ? json
                    : json.data || [];
            if (arr && arr.length > 0) {
                return arr.map((r) => ({
                    id: r.id,
                    name: r.name,
                    type: r.type,
                    format: r.format,
                    autoPrint: r.auto_print ?? r.autoPrint ?? false,
                    intervalSeconds: r.interval_seconds || r.intervalSeconds || 0,
                    is_default: r.is_default ?? r.isDefault ?? false,
                    config: r.config || {},
                }));
            }
        }
    } catch (e) {
        console.warn("Printers: backend fetch error", e.message);
    }

    // 2) fallback local file
    return await getPrintersFromFile(companyId);
}

// ---- Print processing ---- //

async function processSinglePrint(printer, order, items) {
    if (!printer) throw new Error("No printer provided");

    if (printer.format === "receipt" || printer.format === "receipt_v1") {
        const buf = buildReceiptBuffer(order, items);
        if (printer.type === "network") {
            await printTcp(buf, printer.config.host, printer.config.port || 9100);
        } else if (printer.type === "usb") {
            await printUsb(buf, printer.config.usbVendorId, printer.config.usbProductId);
        } else if (printer.type === "bluetooth") {
            await printBluetooth(buf, printer.config.btAddress, printer.config.btChannel || 1);
        } else {
            throw new Error("Unsupported printer type for receipt: " + printer.type);
        }
    } else if (printer.format === "a4" || printer.format === "pdf") {
        const pdfPath = await buildA4PdfPath(order, items);
        await printPdfA4(pdfPath, { printer: printer.config.printerName || printer.config.name || printer.name });
        try {
            fs.unlinkSync(pdfPath);
        } catch (e) { }
    } else if (printer.format === "zpl") {
        if (printer.type !== "network") throw new Error("ZPL printers must be network printers");
        const zplBuf = Buffer.from(order.zpl || order.zpl_text || "", "utf8");
        await printTcp(zplBuf, printer.config.host, printer.config.port || 9100);
    } else {
        throw new Error("Unknown printer format: " + printer.format);
    }
}

async function reportJobStatus(jobId, status, errorText = null) {
    try {
        const body = { status };
        if (errorText) body.error = String(errorText);
        const res = await apiFetch(`/jobs/${jobId}/status`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const txt = await res.text().catch(() => "");
            console.warn("Failed to report job status:", res.status, txt);
        }
    } catch (e) {
        console.warn("reportJobStatus error:", e.message);
    }
}

async function processJob(job) {
    if (!job || !job.id) return;
    const jobId = job.id;

    if (companyQueues.has(job.company_id)) {
        const st = companyQueues.get(job.company_id);
        if (st.processing && st.processing.has(jobId)) {
            console.log("Job already processing:", jobId);
            return;
        }
    }

    if (!companyQueues.has(job.company_id)) companyQueues.set(job.company_id, { processing: new Set() });
    const q = companyQueues.get(job.company_id);
    q.processing.add(jobId);

    try {
        const payload = job.payload || {};
        let order = payload.order || job.order || null;
        let items = payload.items || job.items || [];
        let printer = null;

        if (payload.printerConfig) {
            printer = payload.printerConfig;
        } else if (payload.printer && typeof payload.printer === "object") {
            printer = payload.printer;
        } else if (payload.printer && (typeof payload.printer === "string" || typeof payload.printer === "number")) {
            const printerId = String(payload.printer);
            const p = await getPrinterFromBackend(printerId);
            if (p) printer = p;
        }

        if (!printer) {
            const printers = await getPrintersForCompany(job.company_id);
            if (printers && printers.length) {
                printer = printers.find((p) => p.is_default || p.autoPrint) || printers[0];
            }
        }

        if (!printer) {
            throw new Error("No printer available for company " + job.company_id);
        }

        // interval check (respect printer.intervalSeconds)
        const now = Date.now();
        const printerIdKey = printer.id || (printer.name ? `name:${printer.name}` : String(Math.random()));
        const last = lastPrintedAt.get(printerIdKey) || 0;
        const intervalMs =
            (printer.intervalSeconds || (printer.config && printer.config.intervalSeconds) || 0) * 1000;
        if (intervalMs > 0 && now - last < intervalMs) {
            console.log(`Skipping print for ${jobId} — printer ${printerIdKey} interval not elapsed`);
            await reportJobStatus(jobId, "delayed", `Printer interval ${intervalMs}ms not elapsed`);
            return;
        }

        if (!order) {
            const orderId = payload.orderId || payload.order_id || job.order_id;
            if (orderId) {
                try {
                    const res = await apiFetch(`${API_BASE.replace(/\/api\/print$/, "")}/api/orders/${orderId}`);
                    if (res.ok) {
                        const j = await res.json();
                        if (j.order) {
                            order = j.order;
                            if (!items || items.length === 0) items = j.items || [];
                        } else if (j.data) {
                            order = j.data;
                        }
                    } else {
                        console.warn("Could not fetch order", orderId, "status", res.status);
                    }
                } catch (e) {
                    console.warn("Fetching order failed:", e.message);
                }
            }
        }

        if (!order) {
            throw new Error("No order payload available for job " + jobId);
        }

        console.log(`Printing job ${jobId} to printer ${printer.id || printer.name || "(unknown)"}...`);
        await processSinglePrint(printer, order, items);

        await reportJobStatus(jobId, "done");
        try {
            printedCache.add(order.id);
        } catch { }
        lastPrintedAt.set(printerIdKey, Date.now());
        console.log(`Job ${jobId} printed successfully.`);
    } catch (err) {
        console.error("Job processing failed:", job.id, err && err.message ? err.message : err);
        await reportJobStatus(job.id, "failed", err && err.message ? err.message : String(err));
    } finally {
        const q2 = companyQueues.get(job.company_id);
        if (q2 && q2.processing) q2.processing.delete(job.id);
    }
}

// Poll loop
let polling = false;
async function pollOnce() {
    try {
        const res = await apiFetch(`/jobs/poll`);
        if (!res.ok) {
            const txt = await res.text().catch(() => "");
            console.warn("Poll returned", res.status, txt);
            return;
        }
        const json = await res.json();
        const jobs = Array.isArray(json.jobs)
            ? json.jobs
            : json.jobs && Array.isArray(json.jobs)
                ? json.jobs
                : Array.isArray(json)
                    ? json
                    : json.data || [];
        if (!jobs || jobs.length === 0) return;
        for (const job of jobs) {
            processJob(job).catch((e) => console.error("processJob error", e && e.message ? e.message : e));
        }
    } catch (e) {
        console.warn("Poll error:", e.message || e);
    }
}

async function pollLoop() {
    if (polling) return;
    polling = true;
    let backoff = 1000;
    while (true) {
        try {
            await pollOnce();
            await new Promise((r) => setTimeout(r, 3000));
            backoff = 1000;
        } catch (e) {
            console.error("Poll loop fatal error", e.message || e);
            await new Promise((r) => setTimeout(r, backoff));
            backoff = Math.min(60000, backoff * 2);
        }
    }
}

// ---- Local Express server (health / simple API) ---- //
const app = express();
app.use(bodyParser.json());

// ✅ CORS middleware (FIXED: OPTIONS + methods + headers)
app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    } else {
        res.setHeader("Access-Control-Allow-Origin", "*");
    }

    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});


app.get("/health", (req, res) => {
    res.json({
        ok: true,
        agent: true,
        api_base: API_BASE,
        agent_port: AGENT_PORT,
        processing: Array.from(companyQueues.entries()).map(([companyId, st]) => ({
            companyId,
            processing: Array.from(st.processing || []),
        })),
    });
});

app.get("/printers-file", (req, res) => {
    try {
        if (fs.existsSync(DEFAULT_PRINTER_CONFIG_PATH)) {
            const arr = JSON.parse(fs.readFileSync(DEFAULT_PRINTER_CONFIG_PATH, "utf-8"));
            return res.json({ printers: arr });
        }
        return res.json({ printers: [] });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

app.post("/printers-file", (req, res) => {
    try {
        const arr = req.body.printers || req.body;
        fs.writeFileSync(DEFAULT_PRINTER_CONFIG_PATH, JSON.stringify(arr, null, 2), "utf-8");
        return res.json({ ok: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

// ✅ Select local printer and persist to printers.json (so processJob can pick is_default)
app.post("/local/printers/select", (req, res) => {
    try {
        const body = req.body || {};
        const companyId = String(body.companyId || body.company_id || "").trim();
        const printerName = String(body.printerName || body.printer_name || body.name || "").trim();

        if (!companyId || !printerName) {
            return res.status(400).json({ ok: false, error: "companyId and printerName are required" });
        }

        let arr = [];
        if (fs.existsSync(DEFAULT_PRINTER_CONFIG_PATH)) {
            try {
                arr = JSON.parse(fs.readFileSync(DEFAULT_PRINTER_CONFIG_PATH, "utf8"));
                if (!Array.isArray(arr)) arr = [];
            } catch {
                arr = [];
            }
        }

        // unset previous defaults for this company
        arr = arr.map((p) => (p.company_id === companyId ? { ...p, is_default: false } : p));

        const id = `win:${printerName}`;
        const existingIdx = arr.findIndex((p) => p.company_id === companyId && String(p.id) === id);

        const record = {
            id,
            company_id: companyId,
            name: printerName,
            type: "system",
            format: "a4",
            is_active: true,
            is_default: true,
            autoPrint: true,
            intervalSeconds: 0,
            config: { printerName },
        };

        if (existingIdx >= 0) {
            arr[existingIdx] = { ...arr[existingIdx], ...record };
        } else {
            arr.push(record);
        }

        fs.writeFileSync(DEFAULT_PRINTER_CONFIG_PATH, JSON.stringify(arr, null, 2), "utf8");
        return res.json({ ok: true, selected: record });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message || String(e) });
    }
});

// Local printers listing (robust fallback: Windows PowerShell -> pdf-to-printer -> lpstat)
app.get("/local/printers", async (req, res) => {
    try {
        let list = [];

        // ✅ 1) Windows FIRST: PowerShell Get-Printer (more reliable than pdf-to-printer listing)
        if (process.platform === "win32") {
            try {
                const { spawn } = require("child_process");
                list = await new Promise((resolve) => {
                    const ps = spawn(
                        "powershell.exe",
                        [
                            "-NoProfile",
                            "-NonInteractive",
                            "-Command",
                            "Try { Get-Printer | Select-Object -ExpandProperty Name -ErrorAction SilentlyContinue } Catch { exit 0 }",
                        ],
                        { windowsHide: true }
                    );

                    let out = "";
                    ps.stdout.on("data", (d) => (out += String(d)));
                    ps.stderr.on("data", () => { });
                    const done = () => {
                        const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                        resolve(lines);
                    };
                    ps.on("close", done);
                    ps.on("error", (err) => {
                        console.warn("PowerShell spawn error:", err && err.message ? err.message : err);
                        resolve([]);
                    });

                    // safety timeout
                    setTimeout(() => {
                        try {
                            ps.kill();
                        } catch { }
                        resolve([]);
                    }, 5000);
                });
            } catch (e) {
                console.warn("PowerShell fallback failed:", e && e.message ? e.message : e);
                list = [];
            }
        }

        // 2) Try pdf-to-printer (if installed) — keep as fallback
        if (!list || list.length === 0) {
            try {
                const pdfToPrinter = require("pdf-to-printer");
                if (pdfToPrinter && typeof pdfToPrinter.getPrinters === "function") {
                    const raw = await pdfToPrinter.getPrinters();
                    if (Array.isArray(raw) && raw.length > 0) list = raw;
                }
            } catch (e) {
                console.warn("pdf-to-printer failed to list printers:", e && e.message ? e.message : e);
            }
        }

        // 3) Unix fallback: lpstat
        if ((!list || list.length === 0) && process.platform !== "win32") {
            try {
                const { spawn } = require("child_process");
                list = await new Promise((resolve) => {
                    const sh = spawn("bash", ["-lc", "lpstat -p 2>/dev/null | awk '{print $2}'"], { windowsHide: true });
                    let out = "";
                    sh.stdout.on("data", (d) => (out += String(d)));
                    sh.stderr.on("data", () => { });
                    sh.on("close", () => {
                        const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
                        resolve(lines);
                    });
                    sh.on("error", () => resolve([]));
                    setTimeout(() => {
                        try {
                            sh.kill();
                        } catch { }
                        resolve([]);
                    }, 4000);
                });
            } catch (e) {
                console.warn("lpstat fallback failed:", e && e.message ? e.message : e);
                list = [];
            }
        }

        // Normalize to array of { id, name }
        const printers = (Array.isArray(list) ? list : [])
            .map((n) => {
                try {
                    if (!n && n !== 0) return null;
                    if (typeof n === "string") return { id: String(n), name: n };
                    if (typeof n === "object") {
                        const name = n.name || n.Name || n.printerName || n.PrinterName || String(n);
                        return { id: String(name), name };
                    }
                    return { id: String(n), name: String(n) };
                } catch {
                    return null;
                }
            })
            .filter(Boolean);

        return res.json({ ok: true, printers });
    } catch (err) {
        console.warn("Error listing local printers:", err && err.message ? err.message : err);
        return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
    }
});

app.listen(AGENT_PORT, () => {
    console.log(`Print Agent local API listening at http://localhost:${AGENT_PORT}`);
    pollLoop().catch((e) => console.error("pollLoop failed:", e));
});

// graceful shutdown
process.on("SIGINT", () => {
    console.log("Shutting down print agent...");
    process.exit(0);
});
process.on("SIGTERM", () => {
    console.log("Shutting down print agent...");
    process.exit(0);
});
