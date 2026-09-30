#!/bin/bash
# run_simulation.sh
# Orchestrates the Federated Learning simulation on a single machine.

# Setup default parameters
STRATEGY=${1:-fedavg}
ROUNDS=${2:-20}
MU=${3:-0.1}
EPOCHS=${4:-3}

echo "========================================================="
echo "🌸 Starting Federated Learning Simulation"
echo "   Strategy: $STRATEGY"
echo "   Rounds  : $ROUNDS"
echo "   Local Epochs: $EPOCHS"
echo "========================================================="

# 1. Start Server in the background
echo "🚀 Starting Server (Strategy: $STRATEGY)..."
if [ "$STRATEGY" = "fedprox" ]; then
    python3 server.py --strategy fedprox --rounds $ROUNDS --mu $MU &
else
    python3 server.py --strategy fedavg --rounds $ROUNDS &
fi
SERVER_PID=$!

# Give the server a moment to bind to the port
sleep 3

# 2. Start Clients in the background
echo "🏥 Starting Client 1 (Lung Hospital)..."
python3 client.py \
    --client-dir ./federated_data/client_1_lung_hospital \
    --epochs $EPOCHS &
CLIENT1_PID=$!

sleep 1

echo "🏥 Starting Client 2 (Emergency General)..."
python3 client.py \
    --client-dir ./federated_data/client_2_emergency_general \
    --epochs $EPOCHS &
CLIENT2_PID=$!

sleep 1

echo "🏥 Starting Client 3 (Screening Clinic)..."
python3 client.py \
    --client-dir ./federated_data/client_3_screening_clinic \
    --epochs $EPOCHS &
CLIENT3_PID=$!

echo "========================================================="
echo "✅ All nodes started. Training is running..."
echo "Press Ctrl+C to terminate the entire simulation."
echo "========================================================="

# Trap Ctrl+C (SIGINT) and kill all child processes
trap "echo 'Terminating simulation...'; kill $SERVER_PID $CLIENT1_PID $CLIENT2_PID $CLIENT3_PID; exit 1" SIGINT

# Wait for all processes to finish
wait $SERVER_PID
wait $CLIENT1_PID
wait $CLIENT2_PID
wait $CLIENT3_PID

echo "🎉 Simulation finished."
