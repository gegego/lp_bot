import * as fs from 'fs';
import * as path from 'path';

const csvFilePath = path.join(__dirname, 'balance_history.csv');
const htmlOutputPath = path.join(__dirname, 'balance_chart.html');

interface BalanceData {
    timestamp: string;
    total_sol: number;
    wallet_sol: number;
    position_sol: number;
    wallet_token_sol: number;
}

function parseCSV(filePath: string): BalanceData[] {
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

/**
 * Groups data by hour and finds the maximum total_sol for each hour.
 */
function aggregateDataByHour(data: BalanceData[]): BalanceData[] {
    const hourlyMap: Map<string, BalanceData> = new Map();

    data.forEach(d => {
        // Create an hourly key: YYYY-MM-DDTHH:00:00.000Z
        const date = new Date(d.timestamp);
        date.setMinutes(0, 0, 0);
        const hourlyKey = date.toISOString();

        if (!hourlyMap.has(hourlyKey)) {
            hourlyMap.set(hourlyKey, { ...d, timestamp: hourlyKey });
        } else {
            const current = hourlyMap.get(hourlyKey)!;
            if (d.total_sol > current.total_sol) {
                hourlyMap.set(hourlyKey, { ...d, timestamp: hourlyKey });
            }
        }
    });

    // Return sorted by timestamp
    return Array.from(hourlyMap.values()).sort((a, b) => 
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
}

function generateHTML(data: BalanceData[]) {
    const htmlTemplate = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hourly Max SOL Balance Chart</title>
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
        <h1>Hourly Max SOL Balance History</h1>
        
        <div class="summary">
            <div class="summary-item">
                <div class="summary-label">Latest Max</div>
                <div class="summary-value" id="latest-total">0.00 SOL</div>
            </div>
            <div class="summary-item">
                <div class="summary-label">Hourly Intervals</div>
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
                        label: 'Max Total SOL',
                        data: rawData.map(d => d.total_sol),
                        borderColor: 'rgb(75, 192, 192)',
                        backgroundColor: 'rgba(75, 192, 192, 0.2)',
                        fill: true,
                        tension: 0.1,
                        yAxisID: 'y',
                    },
                    {
                        label: 'Cost (3.87)',
                        data: rawData.map(() => 3.87),
                        borderColor: 'rgb(255, 99, 132)',
                        borderDash: [5, 5],
                        fill: false,
                        pointRadius: 0,
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
                            unit: 'hour',
                            displayFormats: {
                                hour: 'YYYY-MM-DD HH:00'
                            },
                            tooltipFormat: 'YYYY-MM-DD HH:00'
                        },
                        title: {
                            display: true,
                            text: 'Date Hour'
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

const rawData = parseCSV(csvFilePath);
const hourlyMaxData = aggregateDataByHour(rawData);
const html = generateHTML(hourlyMaxData);
fs.writeFileSync(htmlOutputPath, html);
console.log(`Successfully generated ${htmlOutputPath} with ${hourlyMaxData.length} hourly records.`);
