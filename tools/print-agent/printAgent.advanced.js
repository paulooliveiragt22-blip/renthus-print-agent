// printAgent.advanced.js (UPDATED)
// Node 16+
// NOTE: This version DOES NOT use a Supabase service key. It talks to the ERP HTTP API
// via AGENT_KEY. Ensure your ERP implements the endpoints:
//  GET  ${API_BASE}/jobs/poll
//  POST ${API_BASE}/jobs/:id/status
//  (optional) GET ${API_BASE}/printers/:printerId
//  (optional) GET ${API_BASE}/companies/:companyId/printers
//
// Environment:
//  API_BASE (e.g. https://your-renthus-app.com/api/print)
//  AGENT_KEY
//  AGENT_PORT (optional, default 4001)
//  DEFAULT_PRINTER_CONFIG_PATH (optional)
//
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
        // require node-fetch v2 (common)
        // If you use node-fetch v3 (ESM), adapt accordingly.
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
const AGENT_KEY = process.env.AGENT_KEY || "";
const AGENT_PORT = Number(process.env.AGENT_PORT || 4001);
const DEFAULT_PRINTER_CONFIG_PATH = path.resolve(process.cwd(), process.env.DEFAULT_PRINTER_CONFIG_PATH || "printers.json");

if (!AGENT_KEY) {
    console.error("Please set AGENT_KEY environment variable (agent API key).");
    process.exit(1);
}

// In-memory structures
const companyQueues = new Map(); // companyId => { processing: Set(jobId) }
const printedCache = new Set(); // optional local set of printed order ids

// Helper: fetch with Authorization
async function apiFetch(route, opts = {}) {
    const headers = Object.assign({}, opts.headers || {}, {
        Authorization: `Bearer ${AGENT_KEY}`,
    });
    const url = route.startsWith("http") ? route : `${API_BASE}${route.startsWith("/") ? "" : "/"}${route}`;
    const res = await fetchFn(url, Object.assign({}, opts, { headers }));
    return res;
}

// ---- Printing helpers (unchanged behavior) ---- //

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
        const price = (Number(it.unit_price || it.price || 0)).toFixed(2).padStart(6, " ");
        lines.push(esc(`${name}${qty} ${price}\n`));
    });
    lines.push(esc("--------------------------------\n"));

    // totals
    lines.push(Buffer.from([0x1b, 0x45, 1]));
    lines.push(esc(`TOTAL: R$ ${(Number(order.total_amount || order.total || 0)).toFixed(2)}\n`));
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
            doc.text(`${it.product_name || it.name || "(produto)"} x${it.quantity || it.qty || 1}  R$ ${(Number(it.unit_price || it.price || 0)).toFixed(2)}`);
        });

        doc.moveDown();
        doc.fontSize(12).text(`Total: R$ ${(Number(order.total_amount || order.total || 0)).toFixed(2)}`, { align: "right" });

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
            } catch (err) {
                // ignore
            }
            // wait a bit then close
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
        bt.connect(address, channel, () => {
            bt.write(buffer, (err) => {
                if (err) {
                    bt.close();
                    return reject(err);
                }
                setTimeout(() => {
                    try { bt.close(); } catch { }
                    resolve();
                }, 200);
            });
        }, (err) => {
            reject(err || new Error("BT connect error"));
        });
    });
}

async function printPdfA4(filepath, options = {}) {
    // pdf-to-printer's print() returns a promise
    const { print } = require("pdf-to-printer");
    return print(filepath, options);
}

// ---- Helpers to obtain printer configs ---- //

async function getPrintersFromFile(companyId) {
    try {
        if (fs.existsSync(DEFAULT_PRINTER_CONFIG_PATH)) {
            const arr = JSON.parse(fs.readFileSync(DEFAULT_PRINTER_CONFIG_PATH, "utf-8"));
            return arr.filter((p) => p.company_id === companyId && p.is_active !== false).map((p) => ({
                id: p.id,
                name: p.name,
                type: p.type,
                format: p.format,
                autoPrint: p.autoPrint,
                intervalSeconds: p.intervalSeconds || 0,
                config: p
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
        // Expect backend returns printer object { id, name, type, format, config, auto_print... }
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
            // Expect backend -> { printers: [...] } or array
            const arr = Array.isArray(json.printers) ? json.printers : (Array.isArray(json) ? json : (json.data || []));
            if (arr && arr.length > 0) {
                return arr.map((r) => ({
                    id: r.id,
                    name: r.name,
                    type: r.type,
                    format: r.format,
                    autoPrint: r.auto_print || r.autoPrint,
                    intervalSeconds: r.interval_seconds || r.intervalSeconds || 0,
                    config: r.config || {}
                }));
            }
        } else {
            // continue to file fallback
        }
    } catch (e) {
        console.warn("Printers: backend fetch error", e.message);
    }

    // 2) fallback local file
    return await getPrintersFromFile(companyId);
}

// ---- Print processing ---- //

async function processSinglePrint(printer, order, items) {
    // Expect printer to be object { id, type, format, config: {...} }
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
        // use system print
        await printPdfA4(pdfPath, { printer: printer.config.printerName });
        // cleanup
        try { fs.unlinkSync(pdfPath); } catch (e) { /* ignore */ }
    } else if (printer.format === "zpl") {
        // For ZPL, expect printer.type network and payload.zplText
        if (printer.type !== "network") throw new Error("ZPL printers must be network printers");
        const zplBuf = Buffer.from(order.zpl || order.zpl_text || "", "utf8");
        await printTcp(zplBuf, printer.config.host, printer.config.port || 9100);
    } else {
        throw new Error("Unknown printer format: " + printer.format);
    }
}

// ---- Job handling (polling & status reporting) ---- //

async function reportJobStatus(jobId, status, errorText = null) {
    try {
        const body = { status };
        if (errorText) body.error = String(errorText);
        const res = await apiFetch(`/jobs/${jobId}/status`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
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

    // Mark as processing locally
    if (!companyQueues.has(job.company_id)) companyQueues.set(job.company_id, { processing: new Set() });
    const q = companyQueues.get(job.company_id);
    q.processing.add(jobId);

    try {
        // Prefer fully-contained payload
        const payload = job.payload || {};
        const order = payload.order || job.order || null;
        const items = payload.items || job.items || [];
        let printer = null;

        // Determine printer config:
        // 1) if payload.printerConfig present -> use it
        if (payload.printerConfig) {
            printer = payload.printerConfig;
        } else if (payload.printer && typeof payload.printer === "object") {
            // payload.printer may already be full object
            printer = payload.printer;
        } else if (payload.printer && (typeof payload.printer === "string" || typeof payload.printer === "number")) {
            // payload.printer is printerId -> fetch from backend
            const printerId = String(payload.printer);
            const p = await getPrinterFromBackend(printerId);
            if (p) printer = p;
        }

        // 2) fallback: use default company printer if available
        if (!printer) {
            const printers = await getPrintersForCompany(job.company_id);
            if (printers && printers.length) {
                // pick default or first
                printer = printers.find((p) => p.is_default || p.autoPrint) || printers[0];
            }
        }

        // 3) If still no printer -> fail job
        if (!printer) {
            throw new Error("No printer available for company " + job.company_id);
        }

        // 4) ensure we have order data
        if (!order) {
            // try to extract from payload.orderId/order_id or job.order_id
            const orderId = payload.orderId || payload.order_id || job.order_id;
            if (orderId) {
                // try to fetch from backend (this endpoint may be protected; best practice is for backend to include order in payload)
                try {
                    const res = await apiFetch(`${API_BASE.replace(/\/api\/print$/, "")}/api/orders/${orderId}`);
                    if (res.ok) {
                        const j = await res.json();
                        // expect backend returns order + items; adapt if necessary
                        if (j.order) {
                            order = j.order;
                            if (!items || items.length === 0) items = j.items || [];
                        } else if (j.data) {
                            order = j.data;
                        }
                    } else {
                        // fallback: if fetching order fails, we continue only if payload had enough info
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

        // Process the print
        console.log(`Printing job ${jobId} to printer ${printer.id || printer.name || "(unknown)"}...`);
        await processSinglePrint(printer, order, items);

        // Report done
        await reportJobStatus(jobId, "done");
        // optional local bookkeeping
        try { printedCache.add(order.id); } catch { }
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
        const jobs = Array.isArray(json.jobs) ? json.jobs : (json.jobs && Array.isArray(json.jobs) ? json.jobs : (Array.isArray(json) ? json : (json.data || [])));
        if (!jobs || jobs.length === 0) return;
        for (const job of jobs) {
            // process sequentially but do not block polling for other companies; we queue per-company
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
            // normal interval
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

app.get("/health", (req, res) => {
    res.json({
        ok: true,
        agent: true,
        api_base: API_BASE,
        agent_port: AGENT_PORT,
        processing: Array.from(companyQueues.entries()).map(([companyId, st]) => ({
            companyId,
            processing: Array.from(st.processing || [])
        }))
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

app.listen(AGENT_PORT, () => {
    console.log(`Print Agent local API listening at http://localhost:${AGENT_PORT}`);
    // start polling
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
