import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

let pool;

try {
  pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 4000,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ssl: {
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
    },
    connectionLimit: 10,
  });

  console.log("✅ Connected to TiDB successfully!");
} catch (error) {
  console.error("❌ Database connection failed:", error);
}

export default pool;