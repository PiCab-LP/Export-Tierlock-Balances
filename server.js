require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const cors = require('cors');
const { Parser } = require('json2csv');

const app = express();

// Middleware
app.use(express.json());
app.use(cors()); // Permite que tu frontend en Vercel se conecte

// Carga de las compañías
const companias = JSON.parse(fs.readFileSync('companias.json', 'utf8'));

// 🕒 Función de Ajuste de Zona Horaria (-5 horas)
function ajustarHoraLocal(fechaISO) {
    if (!fechaISO) return "";
    const fecha = new Date(fechaISO);
    fecha.setHours(fecha.getHours() - 5);

    const año = fecha.getFullYear();
    const mes = String(fecha.getMonth() + 1).padStart(2, '0');
    const dia = String(fecha.getDate()).padStart(2, '0');
    const horas = String(fecha.getHours()).padStart(2, '0');
    const mins = String(fecha.getMinutes()).padStart(2, '0');
    const segs = String(fecha.getSeconds()).padStart(2, '0');

    return `${año}-${mes}-${dia} ${horas}:${mins}:${segs}`;
}

const jobs = new Map();

// 🚀 ENDPOINT PARA EXPORTAR (Inicia el trabajo)
app.post('/api/exportar', async (req, res) => {
    const { fechaInicio, fechaFin, fecha } = req.body;

    const start = fechaInicio || fecha;
    const end = fechaFin || fecha;

    if (!start || !end) {
        return res.status(400).json({ error: "Las fechas de inicio y fin son requeridas" });
    }

    if (start > end) {
        return res.status(400).json({ error: "La fecha de inicio no puede ser mayor a la de fin" });
    }

    const jobId = Date.now().toString();
    jobs.set(jobId, { 
        status: 'processing', 
        progress: 0, 
        current: 0, 
        total: companias.length,
        start,
        end
    });

    res.json({ jobId });

    // Procesamiento asíncrono en segundo plano
    (async () => {
        console.log(`\nIniciando extracción masiva desde: ${start} hasta: ${end} (Job: ${jobId})`);
        let todasLasTransacciones = [];
        let i = 0;

        for (const compania of companias) {
            i++;
            if (jobs.has(jobId)) {
                const job = jobs.get(jobId);
                job.current = i;
                job.progress = Math.round((i / companias.length) * 100);
            }

            console.log(`🚀 [Job ${jobId}] Procesando: ${compania.nombre} (${i}/${companias.length})...`);

            const merchantId = compania.env_id ? process.env[compania.env_id] : process.env.MERCHANT_ID_GLOBAL;
            const merchantSecret = process.env[compania.env_var];

            if (!merchantId || !merchantSecret) {
                console.error(`❌ Faltan credenciales para ${compania.nombre}.`);
                continue;
            }

            let paginaActual = 1;
            let tieneMasPaginas = true;

            try {
                while (tieneMasPaginas) {
                    const response = await axios.post('https://api.tierlock.com/api/transactions', {
                        merchant_id: merchantId,
                        merchant_secret: merchantSecret,
                        page: paginaActual,
                        start_date: start,
                        end_date: end
                    }, { timeout: 15000 });

                    if (response.data.success) {
                        const transacciones = response.data.data;

                        if (transacciones && transacciones.length > 0) {
                            const dataMapeada = transacciones.map(txn => ({
                                compania_nombre: compania.nombre,
                                transaction_id: txn.transaction_id,
                                order_id: txn.order_id,
                                status: txn.status,
                                monto_total: txn.amount?.total,
                                monto_neto: parseFloat(txn.amount?.net || 0),
                                propina: txn.amount?.tip,
                                comision: txn.amount?.fees,
                                moneda: txn.currency,
                                cliente_email: txn.customer?.email,
                                cliente_tel: txn.customer?.phone,
                                blockchain_hash: txn.blockchain?.transaction_hash,
                                fecha_local: ajustarHoraLocal(txn.timestamps?.created_at)
                            }));

                            todasLasTransacciones.push(...dataMapeada);

                            const totalPaginas = response.data.pagination.total_pages;
                            if (paginaActual < totalPaginas) {
                                paginaActual++;
                            } else {
                                tieneMasPaginas = false;
                            }
                        } else {
                            tieneMasPaginas = false;
                        }
                    } else {
                        tieneMasPaginas = false;
                    }
                }
            } catch (error) {
                console.error(`💥 Error en ${compania.nombre}: ${error.message}`);
                tieneMasPaginas = false;
            }
        }

        if (todasLasTransacciones.length === 0) {
            if (jobs.has(jobId)) {
                const job = jobs.get(jobId);
                job.status = 'error';
                job.error = "No hay transacciones en el rango de fechas seleccionado.";
            }
            return;
        }

        try {
            const json2csvParser = new Parser();
            const csv = json2csvParser.parse(todasLasTransacciones);
            if (jobs.has(jobId)) {
                const job = jobs.get(jobId);
                job.status = 'completed';
                job.csvData = csv;
                job.progress = 100;
            }
        } catch (err) {
            console.error("Error al generar CSV:", err);
            if (jobs.has(jobId)) {
                const job = jobs.get(jobId);
                job.status = 'error';
                job.error = "Error generando el archivo CSV";
            }
        }
    })();
});

// 📊 ENDPOINT PARA VERIFICAR ESTADO
app.get('/api/estado/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Trabajo no encontrado" });
    
    res.json({
        status: job.status,
        progress: job.progress,
        current: job.current,
        total: job.total,
        error: job.error
    });
});

// 📥 ENDPOINT PARA DESCARGAR CSV
app.get('/api/descargar/:jobId', (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job || job.status !== 'completed') {
        return res.status(404).json({ error: "Archivo no disponible o no ha terminado de procesarse" });
    }
    
    const { start, end, csvData } = job;

    res.header('Content-Type', 'text/csv');
    let filename = start === end ? `reporte_${start}.csv` : `reporte_consolidado_${start}_al_${end}.csv`;
    
    // Configura Content-Disposition para que se descargue con el nombre correcto
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvData);
    
    // Limpieza de memoria (opcional, borramos después de descargar para no ocupar RAM)
    jobs.delete(req.params.jobId);
});

// Inicio del servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Servidor backend corriendo en puerto ${PORT}`);
});