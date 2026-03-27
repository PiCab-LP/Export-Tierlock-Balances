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

// 🚀 ENDPOINT PARA EXPORTAR
app.post('/api/exportar', async (req, res) => {
    const { fechaInicio, fechaFin, fecha } = req.body; // Recibe rango o fecha única

    const start = fechaInicio || fecha;
    const end = fechaFin || fecha;

    if (!start || !end) {
        return res.status(400).json({ error: "Las fechas de inicio y fin son requeridas" });
    }

    if (start > end) {
        return res.status(400).json({ error: "La fecha de inicio no puede ser mayor a la de fin" });
    }

    console.log(`\nIniciando extracción masiva desde: ${start} hasta: ${end}`);
    let todasLasTransacciones = [];

    for (const compania of companias) {
        console.log(`🚀 Procesando: ${compania.nombre}...`);

        // --- LÓGICA HÍBRIDA APLICADA ---
        // Si el JSON tiene 'env_id', usa esa variable (para las nuevas y los independientes).
        // Si no lo tiene, usa el MERCHANT_ID_GLOBAL por defecto (para las 32 originales).
        const merchantId = compania.env_id ? process.env[compania.env_id] : process.env.MERCHANT_ID_GLOBAL;
        
        // El secreto siempre lo busca con el nombre definido en el JSON
        const merchantSecret = process.env[compania.env_var];

        if (!merchantId || !merchantSecret) {
            console.error(`❌ Faltan credenciales para ${compania.nombre}. Revisa tus variables en Railway.`);
            continue; // Salta a la siguiente si falta algo
        }

        let paginaActual = 1;
        let tieneMasPaginas = true;

        try {
            while (tieneMasPaginas) {
                const response = await axios.post('https://api.tierlock.com/api/transactions', {
                    merchant_id: merchantId,         // <-- Ahora usa la variable dinámica
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
        return res.status(404).json({ error: "No hay transacciones en el rango de fechas seleccionado." });
    }

    try {
        const json2csvParser = new Parser();
        const csv = json2csvParser.parse(todasLasTransacciones);

        // Configuramos la respuesta como un archivo descargable
        res.header('Content-Type', 'text/csv');
        res.attachment(`reporte_consolidado_${start}_al_${end}.csv`);
        return res.send(csv);

    } catch (err) {
        console.error("Error al generar CSV:", err);
        return res.status(500).json({ error: "Error generando el archivo CSV" });
    }
});

// Inicio del servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Servidor backend corriendo en puerto ${PORT}`);
});