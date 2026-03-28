const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

// test route
app.get("/", (req, res) => {
  res.send("BlessVegs backend draait 🚀");
});

// voorbeeld endpoint (voor later gebruik)
app.post("/order", (req, res) => {
  const data = req.body;
  console.log("Nieuwe bestelling:", data);

  res.json({ success: true, message: "Bestelling ontvangen" });
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
