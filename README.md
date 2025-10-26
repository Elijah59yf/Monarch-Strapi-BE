# Monarch Personal Website - CMS Backend (Strapi)

## 📜 Overview

This repository contains the Strapi v4/v5 Headless CMS backend that powers the [Monarch Personal Website Frontend](https://github.com/Elijah59yf/Monarch-FE). It manages the content for blog posts and projects, providing a REST API for the frontend to consume.

---

## ✨ Features

* **Headless CMS:** Provides content via API, separating content management from frontend presentation.
* **Content Types:** Configured with "Blog Post" and "Project" collection types, including fields for titles, content (Rich Text), slugs, images, links, etc.
* **Role-Based Access Control:** Public API endpoints configured to allow read access (`find`, `findOne`) for posts and projects.
* **Admin Panel:** Strapi's built-in admin dashboard for easy content creation and management.
* **Self-Hosted:** Runs locally on a personal machine, exposed via Cloudflare Tunnel.

---

## 🛠️ Technology Stack

* **CMS Framework:** [Strapi](https://strapi.io/) (v4/v5 - JavaScript)
* **Database:** [MariaDB](https://mariadb.org/) (Configured via `config/database.js`)
* **Runtime:** [Node.js](https://nodejs.org/)
* **Dependencies:** Managed via `package.json`
* **Process Management:** [PM2](https://pm2.keymetrics.io/)

---

## 🚀 Getting Started (Local Development / Replication)

### Prerequisites

* Node.js (v18+ recommended) & npm (use `nvm` recommended).
* PM2 installed globally (`npm install pm2 -g`).
* A running MariaDB (or compatible MySQL) database server.

### Steps

1.  **Clone the repository:**
    ```bash
    git clone [https://github.com/Elijah59yf/Monarch-Strapi-BE.git](https://github.com/Elijah59yf/Monarch-Strapi-BE.git)
    cd Monarch-Strapi-BE
    ```
2.  **Install dependencies:**
    ```bash
    npm install
    ```
3.  **Database Setup:**
    * Ensure MariaDB is running.
    * Create a database (e.g., `strapi_db`) and user (e.g., `strapi_user`) with appropriate privileges. Example SQL:
      ```sql
      CREATE DATABASE strapi_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
      CREATE USER 'strapi_user'@'localhost' IDENTIFIED BY 'your_db_password';
      GRANT ALL PRIVILEGES ON strapi_db.* TO 'strapi_user'@'localhost';
      FLUSH PRIVILEGES;
      ```
4.  **Create `.env` file:** Create a file named `.env` in the root directory. Strapi requires specific variables for database connection and server configuration. Refer to the Strapi documentation and your `config/database.js` file for the necessary variables. Minimally, you'll need:
    ```dotenv
    # .env - Example for MariaDB/MySQL
    HOST=127.0.0.1
    PORT=1337
    APP_KEYS= # Generate using 'openssl rand -base64 32' or copy existing from your setup
    API_TOKEN_SALT= # Generate or copy existing
    ADMIN_JWT_SECRET= # Generate or copy existing
    TRANSFER_TOKEN_SALT= # Generate or copy existing
    JWT_SECRET= # Generate or copy existing

    # Database Credentials
    DATABASE_CLIENT=mysql
    DATABASE_HOST=127.0.0.1
    DATABASE_PORT=3306
    DATABASE_NAME=strapi_db
    DATABASE_USERNAME=strapi_user
    DATABASE_PASSWORD=your_db_password
    DATABASE_SSL=false
    ```
    * **Important:** Generate **secure, unique random strings** for all secret keys (`APP_KEYS`, `..._SALT`, `..._SECRET`). If you are replicating your existing setup, copy these values from your current `.env` file.
5.  **Build the Admin Panel:**
    ```bash
    npm run build
    ```
6.  **Run the server:**
    * Development: `npm run develop` (Creates admin user on first run if database is empty)
    * Production: `npm run start`
    * Service: `pm2 start npm --name monarch-cms -- run start`

The CMS admin panel will typically be available at `http://localhost:1337/admin`. The API endpoints are under `http://localhost:1337/api/...`.

---

## ⚙️ Key Configuration Files

* **`.env`:** Stores sensitive credentials and environment settings. **MUST NOT** be committed to Git.
* **`config/database.js`:** Database connection settings (reads from `.env`).
* **`config/middlewares.js`:** CORS policy and other middlewares.
* **`config/admin.js`:** Admin panel configurations (reads secrets from `.env`).
* **`config/server.js`:** Server host/port, public URLs, etc.
* **`src/api/*/content-types/*/schema.json`:** Content Type definitions (Blog Post, Project).

---

## ☁️ Deployment

This Strapi instance runs locally using PM2 (started on boot) and is exposed via a Cloudflare Tunnel:

* **Public API URL:** `https://api.monarchdem.me`
* **Local Service:** `http://localhost:1337`

---

## 🤝 Contributing

Suggestions welcome via the [frontend repository's issues page](https://github.com/Elijah59yf/Monarch-FE/issues).

---

## 📝 License

Currently unlicensed.

---

_Developed by Akinseloyin Elijah Oluwademilade (Monarch)_
