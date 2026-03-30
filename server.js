import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

app.use(cors({
  origin: process.env.FRONTEND_URL
}));

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;

function createToken() {
  return jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "12h" });
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/admin/login", (req, res) => {
  const { username, password } = req.body;

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Onjuiste login" });
  }

  const token = createToken();

  res.json({
    ok: true,
    token
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running");
});
