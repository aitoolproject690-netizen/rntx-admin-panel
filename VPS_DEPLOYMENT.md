# RNTX ADMIN PANEL — VPS Deployment

## Recommended VPS
Ubuntu 24.04 LTS, 1 GB RAM minimum for a small deployment; 2 GB is more comfortable.

## 1. DNS
Create an A record such as `panel.example.com` pointing to the VPS public IPv4 address.

## 2. Install packages
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx unzip curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs build-essential
sudo npm install -g pm2
node -v
npm -v
```

## 3. Upload the project
```bash
sudo mkdir -p /opt/rntx-admin
sudo chown -R $USER:$USER /opt/rntx-admin
cd /opt/rntx-admin
unzip RNTX_ADMIN_PANEL_VPS.zip
npm install
```

If the zip is uploaded to another location, copy it into `/opt/rntx-admin` first.

## 4. Configure secrets
Create `/opt/rntx-admin/.env` with:
```env
NODE_ENV=production
PORT=3000
ADMIN_USERNAME=your_admin_username
ADMIN_PASSWORD=use_a_long_unique_password
SESSION_SECRET=use_a_long_random_secret
```

The current starter reads environment variables directly. If you want `.env` support, install `dotenv` and add `require('dotenv').config()` at the very top of `server.js`, then run `npm install dotenv`.

Alternatively export the variables through PM2/systemd.

## 5. Start with PM2
```bash
cd /opt/rntx-admin
export NODE_ENV=production
export PORT=3000
export ADMIN_USERNAME='your_admin_username'
export ADMIN_PASSWORD='your_long_password'
export SESSION_SECRET='your_long_random_secret'
pm install
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```
Run the command printed by `pm2 startup` as instructed by PM2.

Check:
```bash
pm2 status
pm2 logs rntx-admin-panel
curl http://127.0.0.1:3000/api/me
```

## 6. Configure Nginx
Copy `nginx-rntx.conf` to:
```bash
sudo cp nginx-rntx.conf /etc/nginx/sites-available/rntx-admin
sudo nano /etc/nginx/sites-available/rntx-admin
```
Replace `YOUR_DOMAIN` with the real domain.

Enable it:
```bash
sudo ln -s /etc/nginx/sites-available/rntx-admin /etc/nginx/sites-enabled/rntx-admin
sudo nginx -t
sudo systemctl reload nginx
```

## 7. HTTPS with Let's Encrypt
After DNS points to the VPS:
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d panel.example.com
sudo certbot renew --dry-run
```

## 8. Firewall
```bash
sudo apt install -y ufw
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```
Do not expose port 3000 publicly; Nginx should proxy to `127.0.0.1:3000`.

## 9. Database backup
The starter uses SQLite (`rntx.db`). Back it up regularly:
```bash
sudo mkdir -p /var/backups/rntx
sudo cp /opt/rntx-admin/rntx.db /var/backups/rntx/rntx-$(date +%F).db
```
For production with many users, migrate to PostgreSQL and add automated backups.

## 10. Updating the panel
```bash
cd /opt/rntx-admin
# replace project files with the new release
npm install
pm2 restart rntx-admin-panel
```
Back up `rntx.db` before updates.

## Security checklist
- Use HTTPS.
- Use strong unique admin credentials and SESSION_SECRET.
- Keep Ubuntu, Node, Nginx and dependencies updated.
- Add rate limiting and audit logs before opening the panel publicly.
- Do not commit secrets or the production database to a public repository.
- Restrict SSH with keys where possible.
