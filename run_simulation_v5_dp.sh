#!/bin/bash
# run_simulation_v5_dp.sh

SIGMA=${1:-0.01}
ROUNDS=${2:-30}
EPOCHS=${3:-3}
C=${4:-1.0}

echo "=========================================================="
echo "🛡️ Starting FL Simulation V5 (Differential Privacy)"
echo "Sigma (Noise): $SIGMA | C (Clip): $C | Rounds: $ROUNDS | Epochs: $EPOCHS"
echo "=========================================================="

pkill -f "python3 client_v5_dp.py"
pkill -f "python3 server_v5_dp.py"

echo "Starting Server..."
python3 server_v5_dp.py --rounds $ROUNDS --sigma $SIGMA &
SERVER_PID=$!
sleep 15

echo "Starting Clients..."
python3 client_v5_dp.py --client-dir federated_data/client_1_lung_hospital --epochs $EPOCHS --sigma $SIGMA --c $C &
CLIENT1_PID=$!

python3 client_v5_dp.py --client-dir federated_data/client_2_emergency_general --epochs $EPOCHS --sigma $SIGMA --c $C &
CLIENT2_PID=$!

python3 client_v5_dp.py --client-dir federated_data/client_3_screening_clinic --epochs $EPOCHS --sigma $SIGMA --c $C &
CLIENT3_PID=$!

trap "echo '🛑 Stopping simulation...'; kill $SERVER_PID $CLIENT1_PID $CLIENT2_PID $CLIENT3_PID; exit" SIGINT SIGTERM

wait $SERVER_PID
echo "🎉 Simulation V5 DP finished."
kill $CLIENT1_PID $CLIENT2_PID $CLIENT3_PID 2>/dev/null
