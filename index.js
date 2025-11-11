import express from "express";
import dotenv from "dotenv";
//import accountRoute from "./routes/accountRoute.js";
import transactionRoute from "./routes/transactionRoute.js";
import adminRoute from "./routes/adminRoute.js";
import clientRoute from "./routes/clientRoute.js";
import "./config/db.js"

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`, req.body);
  next();
});

app.use(express.json());
app.use(express.static("pages"));

// Routes
//app.use("/api/account", accountRoute);
app.use("/api/transaction", transactionRoute);
app.use("/api/admin", adminRoute);
app.use("/api/client", clientRoute);

app.get("/", (req, res) => {
  res.sendFile("index.html", { root: "pages" });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));