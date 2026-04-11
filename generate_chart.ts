import * as fs from 'fs';
import * as path from 'path';

const csvFilePath = path.join(__dirname, 'balance_history.csv');
const htmlOutputPath = path.join(__dirname, 'balance_chart.html');

function parseCSV(filePath: string) {
    if (!fs.existsSync(filePath)) {
        console.error(`Error: ${filePath} does not exist.`);
        return [];
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    
    // Skip header
    const dataLines = lines.slice(1);
    
    return dataLines.map(line => {
        const [timestamp, total_sol, wallet_sol, position_sol, wallet_token_sol] = line.split(',');
        return {
            timestamp,
            total_sol: parseFloat(total_sol),
            wallet_sol: parseFloat(wallet_sol),
            position_sol: parseFloat(position_sol),
            wallet_token_sol: parseFloat(wallet_token_sol)
        };
    });
}

function generateHTML(data: any[]) {
    const labels = data.map(d => d.timestamp);
    const totalSolData = data.map(d => d.total_sol);

    const htmlTemplate = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Balance History Chart</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/moment@2.29.4/moment.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-moment@1.0.1/dist/chartjs-adapter-moment.min.js"></script>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            margin: 20px;
            background-color: #f4f7f6;
        }
        .container {
            max-width: 1000px;
            margin: 0 auto;
            background: white;
            padding: 20px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        h1 {
            text-align: center;
            color: #333;
        }
        .summary {
            display: flex;
            justify-content: space-around;
            margin-bottom: 20px;
            text-align: center;
        }
        .summary-item {
            flex: 1;
        }
        .summary-value {
            font-size: 1.5em;
            font-weight: bold;
            color: #4bc0c0;
        }
        .summary-label {
            color: #777;
            font-size: 0.9em;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>SOL Balance History</h1>
        
        <div class="summary">
            <div class="summary-item">
                <div class="summary-label">Latest Total</div>
                <div class="summary-value" id="latest-total">0.00 SOL</div>
            </div>
            <div class="summary-item">
                <div class="summary-label">Records</div>
                <div class="summary-value" id="record-count">0</div>
            </div>
        </div>

        <canvas id="balanceChart"></canvas>
    </div>

    <script>
        const rawData = ${JSON.stringify(data)};
        
        if (rawData.length > 0) {
            const latest = rawData[rawData.length - 1];
            document.getElementById('latest-total').textContent = latest.total_sol.toFixed(4) + ' SOL';
            document.getElementById('record-count').textContent = rawData.length;
        }

        const ctx = document.getElementById('balanceChart').getContext('2d');
        new Chart(ctx, {
            type: 'line',
            data: {
                labels: rawData.map(d => d.timestamp),
                datasets: [
                    {
                        label: 'Total SOL',
                        data: rawData.map(d => d.total_sol),
                        borderColor: 'rgb(75, 192, 192)',
                        backgroundColor: 'rgba(75, 192, 192, 0.2)',
                        fill: true,
                        tension: 0.1,
                        yAxisID: 'y',
                    }
                ]
            },
            options: {
                responsive: true,
                scales: {
                    x: {
                        type: 'time',
                        time: {
                            unit: 'minute',
                            displayFormats: {
                                minute: 'HH:mm'
                            }
                        },
                        title: {
                            display: true,
                            text: 'Time'
                        }
                    },
                    y: {
                        beginAtZero: false,
                        title: {
                            display: true,
                            text: 'SOL Amount'
                        }
                    }
                },
                plugins: {
                    legend: {
                        position: 'top',
                    },
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                    }
                }
            }
        });
    </script>
</body>
</html>
    `;
    return htmlTemplate;
}

const data = parseCSV(csvFilePath);
const html = generateHTML(data);
fs.writeFileSync(htmlOutputPath, html);
console.log(`Successfully generated ${htmlOutputPath} with ${data.length} records.`);
