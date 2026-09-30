#!/bin/bash
# run_simulation_v2.sh
# Usage: bash run_simulation_v2.sh [STRATEGY] [ROUNDS] [MU] [EPOCHS]

STRATEGY=${1:-"fedprox"}
ROUNDS=${2:-50}
MU=${3:-1.0}
EPOCHS=${4:-1}

echo "=========================================================="
echo "🚀 Starting Federated Learning Simulation V2"
echo "Strategy: $STRATEGY"
echo "Rounds: $ROUNDS"
echo "Mu (FedProx): $MU"
echo "Local Epochs: $EPOCHS"
echo "=========================================================="

# Cleanup previous zombie processes
pkill -f server_v2.py 2>/dev/null
pkill -f client_v2.py 2>/dev/null
sleep 2

# Start server in background
python3 server_v2.py --strategy $STRATEGY --rounds $ROUNDS --mu $MU &
SERVER_PID=$!
sleep 5  # Give server time to start

# Start clients in background
python3 client_v2.py --client-dir ./federated_data/client_1_lung_hospital --epochs $EPOCHS &
CLIENT1_PID=$!
sleep 2

python3 client_v2.py --client-dir ./federated_data/client_2_emergency_general --epochs $EPOCHS &
CLIENT2_PID=$!
sleep 2

python3 client_v2.py --client-dir ./federated_data/client_3_screening_clinic --epochs $EPOCHS &
CLIENT3_PID=$!

echo "🔄 All FL nodes are running. Waiting for simulation to finish..."

# Wait for server to finish
wait $SERVER_PID

echo "🛑 Cleaning up clients..."
kill $CLIENT1_PID $CLIENT2_PID $CLIENT3_PID 2>/dev/null
pkill -f client_v2.py 2>/dev/null

echo "🎉 Simulation V2 finished."
