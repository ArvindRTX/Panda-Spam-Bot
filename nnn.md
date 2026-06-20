
## Deploying on Render (Free Web Service)

1. Push your repository to **GitHub**.
2. Go to [Render](https://render.com/) and click **New +** -> **Web Service**.
3. Select your GitHub repository.
4. Configure the Web Service:
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
5. Scroll down and click **Advanced** -> **Add Environment Variable** to add:
   - `DISCORD_TOKEN`: (Your Discord Bot Token)
   - `CLIENT_ID`: (Your Discord Client ID)
6. Click **Create Web Service**. 

> [!WARNING]
> On the free tier, Render puts Web Services to sleep after 15 minutes of web traffic inactivity. To keep your bot running 24/7, you can set up a free monitoring tool (like **UptimeRobot** or **Cron-job.org**) to ping your Render Web Service URL (e.g. `https://your-app.onrender.com/`) every 10 minutes.

---