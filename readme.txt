
To Start Server:
> yarn server

To Run Cron job:
> yarn start

Make sure Chrome is started in debug mode to use this script.
 From Console, run this:
start chrome --remote-debugging-port=9222

If Port already is in use (older server):
# Find the PID of the process running on port 3000
netstat -ano | findstr :3000

# Kill the process using its PID (replace <PID> with the actual PID)
taskkill /PID <PID> /F


