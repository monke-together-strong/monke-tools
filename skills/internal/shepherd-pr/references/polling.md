# Polling

When a polling check yields nothing new to process:

1. Ensure one heartbeat is running every five minutes. Each tick sends exactly
   `continue` to the thread.
2. On `continue`, check again.
3. If `continue` arrives while work is already in progress, ignore it.
4. Stop the heartbeat when the polling task is finished.
