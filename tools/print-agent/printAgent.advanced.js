// printAgent.advanced.js
// Node 16+
// Dependências: @supabase/supabase-js express body-parser pdfkit pdf-to-printer escpos escpos-usb bluetooth-serial-port
// Ajuste o package.json e rode npm install

const net = require("net");
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const PDFDocument = require("pdfkit");
const { print } = require("pdf-to-printer");

// Tentativas de importar libs opcionais de hardware:
let escpos, escposUsb, BluetoothSerialPort;
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

// CONFIG (env)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const AGENT_PORT = Number(process.env.AGENT_PORT || 4001);
const DEFAULT_PRINTER_CONFIG_PATH = path.resolve(process.cwd(), "printers.json");

// Supabase client (use service role)
if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Please set SUPABASE_URL and SUPABASE_KEY");
    process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// In-memory queues and timers per company
const companyQueues = new Map(); // companyId => { orders: [], timer: NodeTimer|null, intervalSeconds }
const printedCache = new Set();  // in-memory, optional; persistent check via print_jobs

// Helper para obter impressoras: tenta DB => fallback para printers.json
async function getPrintersForCompany(companyId) {
    // 1) try DB table printers
    try {
        const { data, error } = await sb
            .from("printers")
            .select("*")
            .eq("company_id", companyId)
            .eq("is_active", true);
        if (!error && Array.isArray(data) && data.length > 0) {
            // assume config in "config" jsonb field
            return data.map((r) => ({
                id: r.id,
                name: r.name,
                type: r.type,
                format: r.format,
                autoPrint: r.auto_print,
                intervalSeconds: r.interval_seconds,
                config: r.config || {},
            }));
        }
    } catch (e) {
        console.warn("Printers: db fetch error", e.message);
    }

    // 2) fallback local file
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

// Build ESC/POS receipt buffer (receipt format)
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

// Build PDF A4 for order using PDFKit
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

        const tableTop = doc.y;
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

// Print buffer to network TCP
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

// Print buffer via escpos USB (if available)
async function printUsb(buffer, usbVendorId, usbProductId) {
    if (!escpos || !escposUsb) throw new Error("escpos or escpos-usb not installed");
    const device = new escposUsb(usbVendorId, usbProductId);
    const printer = new escpos.Printer(new escpos.Device(device));
    return new Promise((resolve, reject) => {
        device.open((err) => {
            if (err) return reject(err);
            printer.raw(buffer);
            // raw writes, we wait a bit then close
            setTimeout(() => {
                try {
                    device.close();
                } catch { }
                resolve();
            }, 200);
        });
    });
}

// Print via bluetooth SPP (if library installed)
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

// Print PDF A4 using OS
async function printPdfA4(filepath, options = {}) {
    // use pdf-to-printer
    return print(filepath, options);
}

// Persist print_job record in DB
async function createPrintJobRecord(companyId, orderId, payload = {}, status = "pending", error = null) {
    try {
        await sb.from("print_jobs").insert([{ company_id: companyId, order_id: orderId, status, payload, error }]);
    } catch (e) {
        console.warn("Could not create print_jobs record:", e.message);
    }
}

// Check if order already printed via print_jobs or orders.printed_at
async function alreadyPrinted(orderId) {
    try {
        const { data } = await sb.from("print_jobs").select("id").eq("order_id", orderId).eq("status", "done").limit(1);
        if (data && data.length) return true;
        const { data: orders, error } = await sb.from("orders").select("printed_at").eq("id", orderId).limit(1).single();
        if (!error && orders && orders.printed_at) return true;
    } catch (e) {
        // ignore - false by default
    }
    return false;
}

// fetch order + items + customer extras
async function fetchOrderFull(orderId) {
    const { data: orderData, error: orderErr } = await sb.from("orders").select("*").eq("id", orderId).limit(1).single();
    if (orderErr) throw orderErr;
    const { data: items, error: itemsErr } = await sb.from("order_items").select("*").eq("order_id", orderId);
    if (itemsErr) console.warn("items fetch err", itemsErr.message);
    // try to fetch company name
    let companyName = null;
    try {
        const { data: comp } = await sb.from("companies").select("name").eq("id", orderData.company_id).limit(1).single();
        companyName = comp?.name;
    } catch (e) { }
    return { order: { ...orderData, company_name: companyName }, items: items || [] };
}

// Process a single order printing to the provided printer config
async function processSinglePrint(printer, order, items) {
    // create job record pending
    await createPrintJobRecord(order.company_id, order.id, { printer: printer.id }, "pending", null);
    try {
        if (printer.format === "receipt") {
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
        } else if (printer.format === "a4") {
            const pdfPath = await buildA4PdfPath(order, items);
            // use system print
            await printPdfA4(pdfPath, { printer: printer.config.printerName });
            // optional: cleanup file after printing
            try { fs.unlinkSync(pdfPath); } catch (e) { }
        } else {
            throw new Error("Unknown printer format: " + printer.format);
        }
        // mark job done
        await sb.from("print_jobs").insert([{ company_id: order.company_id, order_id: order.id, status: "done", payload: { printer: printer.id } }]);
        // update orders.printed_at
        try {
            await sb.from("orders").update({ printed_at: new Date().toISOString() }).eq("id", order.id);
        } catch (e) { }
        console.log("Printed order", order.id, "on printer", printer.name || printer.id);
    } catch (err) {
        console.error("Print error", err.message || err);
        await sb.from("print_jobs").insert([{ company_id: order.company_id, order_id: order.id, status: "failed", error: String(err) }]);
        throw err;
    }
}

// Process queue for a company: iterate orders and printers
async function processCompanyQueue(companyId) {
    const queue = companyQueues.get(companyId);
    if (!queue || queue.orders.length === 0) return;
    // fetch printers
    const printers = await getPrintersForCompany(companyId);
    if (!printers || printers.length === 0) {
        console.warn("No printers for company", companyId);
        return;
    }

    // drain orders snapshot
    const ordersToProcess = queue.orders.splice(0, queue.orders.length);

    for (const orderPayload of ordersToProcess) {
        const orderId = orderPayload.id || orderPayload.order_id;
        if (!orderId) continue;
        if (await alreadyPrinted(orderId)) {
            console.log("Order already printed (db):", orderId);
            continue;
        }

        // fetch full
        let order, items;
        if (orderPayload.items && orderPayload.items.length) {
            order = orderPayload;
            items = orderPayload.items;
        } else {
            const r = await fetchOrderFull(orderId);
            order = r.order;
            items = r.items;
        }

        // for each printer for the company (filter by format supported)
        for (const p of printers) {
            try {
                await processSinglePrint(p, order, items);
            } catch (e) {
                console.error("Failed to print order", orderId, "on printer", p.id, e.message);
            }
        }
    }
}

// Enfileira um pedido para uma company e gerencia timers
async function enqueueOrder(companyId, orderPayload) {
    if (!companyQueues.has(companyId)) {
        companyQueues.set(companyId, { orders: [], timer: null, intervalSeconds: 0 });
        // try to set intervalSeconds from printers
        const printers = await getPrintersForCompany(companyId);
        const interval = printers && printers.length ? Math.max(...printers.map(p => p.intervalSeconds || 0)) : 0;
        companyQueues.get(companyId).intervalSeconds = interval;
        if (interval && interval > 0) {
            // set timer
            const t = setInterval(() => {
                processCompanyQueue(companyId).catch((e) => console.error(e));
            }, interval * 1000);
            companyQueues.get(companyId).timer = t;
        }
    }

    const q = companyQueues.get(companyId);
    q.orders.push(orderPayload);

    // if intervalSeconds == 0 for this company, print immediately
    if (!q.intervalSeconds || q.intervalSeconds === 0) {
        // process immediately but avoid blocking realtime handler
        setImmediate(() => {
            processCompanyQueue(companyId).catch((e) => console.error(e));
        });
    } else {
        // will be processed by timer
        console.log(`Enqueued order ${orderPayload.id || orderPayload.order_id} for company ${companyId} (will flush every ${q.intervalSeconds}s)`);
    }
}

// Handler when a new order event arrives
async function handleNewOrderEvent(payload) {
    try {
        const record = payload; // payload.new if you're tying directly to realtime
        const orderId = record.id || record.order_id;
        if (!orderId) return;
        if (await alreadyPrinted(orderId)) {
            console.log("Skipping already printed order (db):", orderId);
            return;
        }
        // enqueue
        await enqueueOrder(record.company_id, record);
    } catch (e) {
        console.error("handleNewOrderEvent error:", e.message);
    }
}

// Start agent
async function startAgent() {
    // Start subscriptions to Supabase realtime (using Realtime via sb.channel)
    const channel = sb.channel("public:orders")
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "orders" }, (payload) => {
            console.log("Realtime order insert:", payload);
            handleNewOrderEvent(payload.new || payload).catch(console.error);
        })
        .subscribe((status) => {
            console.log("Realtime subscribe status:", status);
        });

    // Express endpoints
    const app = express();
    app.use(bodyParser.json());

    // Reprint endpoint
    app.post("/print-order", async (req, res) => {
        try {
            const { orderId } = req.body;
            if (!orderId) return res.status(400).json({ error: "orderId required" });
            const { order, items } = await fetchOrderFull(orderId);
            await enqueueOrder(order.company_id, { ...order, items });
            res.json({ ok: true });
        } catch (e) {
            console.error(e);
            res.status(500).json({ error: String(e) });
        }
    });

    // List printers for company (from DB or config)
    app.get("/printers/:companyId", async (req, res) => {
        try {
            const printers = await getPrintersForCompany(req.params.companyId);
            res.json({ ok: true, printers });
        } catch (e) {
            res.status(500).json({ error: String(e) });
        }
    });

    // Manual enqueue (useful for testing)
    app.post("/enqueue", async (req, res) => {
        try {
            const { order } = req.body;
            if (!order || !order.id || !order.company_id) return res.status(400).json({ error: "order with id and company_id required" });
            await enqueueOrder(order.company_id, order);
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ error: String(e) });
        }
    });

    app.listen(AGENT_PORT, () => {
        console.log(`Print Agent listening on http://localhost:${AGENT_PORT}`);
    });

    console.log("Print Agent started and listening for new orders...");
}

startAgent().catch((e) => {
    console.error("Agent error", e);
    process.exit(1);
});
