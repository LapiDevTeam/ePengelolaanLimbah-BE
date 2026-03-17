require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
const port = process.env.PORT || 3035;

// --- Main Application Start ---
const startServer = async () => {
  try {
    // Try to connect to database, but don't fail if it's not available
    let sequelize = null;
    try {
      const { sequelize: seq } = require("./models");
      await seq.authenticate();
      sequelize = seq;
      console.log("Database connection has been established successfully.");
    } catch (dbError) {
      console.warn("Database connection failed, running without database:", dbError.message);
      console.warn("Some features may not work without database connection.");
    }

    // --- Express Middleware & Routes ---
    app.use(cors()); // Enable CORS for frontend communication
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    // A simple root route to confirm the API is running
    app.get("/", (req, res) => {
      res.send("Waste Management API is running!");
    });

    // --- Add your application routes here ---
    // 1. Import the route files
    const authRoutes = require("./routes/authRoutes");
    const permohonanRoutes = require("./routes/permohonanRoutes");
    const beritaAcaraRoutes = require("./routes/beritaAcaraRoutes");
    const optionsRoutes = require("./routes/optionsRoutes");
    const configRoutes = require("./routes/configRoutes");
    const workflowRoutes = require("./routes/workflowRoutes");
    const labelRoutes = require("./routes/labelRoutes");
    const userRoutes = require("./routes/userRoutes");
    const documentGenerationRoutes = require("./routes/documentGenerationRoutes");
    const dashboardRoutes = require("./routes/dashboardRoutes");
    const auditLogRoutes = require("./routes/auditLogRoutes");

    // 2. Use the routes with their base paths
    app.use("/api/auth", authRoutes);
    app.use("/api/permohonan", permohonanRoutes);
    app.use("/api/berita-acara", beritaAcaraRoutes);
    app.use("/api/options", optionsRoutes);
    app.use("/api/config", configRoutes);
    app.use("/api/workflows", workflowRoutes);
    app.use("/api/labels", labelRoutes);
    app.use("/api/users", userRoutes);
    app.use("/api/document-generation", documentGenerationRoutes);
    app.use("/api/dashboard", dashboardRoutes);
    app.use("/api/audit-logs", auditLogRoutes);

    // --- Health Check (Optional, as sequelize.authenticate() already checks) ---
    app.get("/health", (req, res) => {
      // If we've reached this point, the server is up and the DB was connected at startup.
      res.status(200).send({ status: "ok", message: "Server is healthy" });
    });

    app.listen(port, () => {
      console.log(`Server listening on port ${port}`);
    });
  } catch (error) {
    console.error("Failed to start the server:", error);
    process.exit(1);
  }
};

startServer();
