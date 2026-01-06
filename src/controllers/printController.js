const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

class PrintController {
  /**
   * Print Permohonan Pemusnahan Limbah B3
   * GET /api/print-permohonan-pemusnahan
   * Query params: link, requestId, createdAt
   */
  static async printPermohonanPemusnahan(req, res) {
    const { link, requestId, createdAt } = req.query;

    // Validate required parameters
    if (!link) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameter: link",
      });
    }

    if (!createdAt) {
      return res.status(400).json({
        success: false,
        error: "Missing required parameter: createdAt",
      });
    }

    let browser;
    try {
      // Konversi logo ke base64
      // Try multiple possible logo locations
      const possibleLogoPaths = [
        path.join(__dirname, "../../../ePemusnahanLimbah-FE/public/logo_bnw.png"),
        path.join(__dirname, "../../public/logo_bnw.png"),
        "C:\\inetpub\\wwwroot\\ePemusnahanLimbah\\logo_bnw.png",
        path.join(__dirname, "../../../ePemusnahanLimbah/logo_bnw.png"),
      ];

      let logoBase64 = "";
      let logoPath = null;

      for (const testPath of possibleLogoPaths) {
        if (fs.existsSync(testPath)) {
          logoPath = testPath;
          break;
        }
      }

      if (logoPath) {
        const logoBuffer = fs.readFileSync(logoPath);
        logoBase64 = `data:image/png;base64,${logoBuffer.toString("base64")}`;
      } else {
        console.warn("PrintController: logo_bnw.png not found in any expected location:", possibleLogoPaths);
      }

      // Launch browser
      browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });

      const page = await browser.newPage();

      // If the incoming request carried an Authorization header, pass the token
      // into the headless browser so the frontend page can authenticate itself
      // (the app uses sessionStorage/localStorage for tokens). This prevents
      // puppeteer from being redirected to the login page.
      const authHeader = req.headers.authorization || req.headers.Authorization || "";
      const token =
        authHeader && authHeader.toString().startsWith("Bearer ") ? authHeader.toString().slice(7) : authHeader;

      if (!token) {
        console.warn("PrintController: No authorization token found in request headers");
        if (browser) await browser.close();
        return res.status(401).json({
          success: false,
          error: "Authentication token required. Please include Authorization header with Bearer token.",
        });
      }

      // Set up authentication with the provided token
      try {
        // Inject token into localStorage/sessionStorage before any script runs
        await page.evaluateOnNewDocument((t) => {
          try {
            localStorage.setItem("token", t);
            sessionStorage.setItem("access_token", t);

            // Many SPAs also require user data in storage to recognize authenticated state.
            // Create a minimal user object that matches what the SPA expects.
            const mockUser = {
              log_NIK: "SYSTEM",
              Nama: "Print User",
              Jabatan: "System",
              role: "Pemohon",
              emp_DeptID: "SYS",
              emp_JobLevelID: "USR",
            };
            localStorage.setItem("user", JSON.stringify(mockUser));
            sessionStorage.setItem("user", JSON.stringify(mockUser));
          } catch (e) {
            // ignore storage errors
          }
        }, token);

        // Also set Authorization header for subsequent resource requests
        await page.setExtraHTTPHeaders({ Authorization: `Bearer ${token}` });

        // Enable request interception to attach Authorization header for SPA XHR/fetch calls.
        try {
          await page.setRequestInterception(true);
          page.on("request", (req) => {
            try {
              const headers = Object.assign({}, req.headers());
              headers["Authorization"] = `Bearer ${token}`;
              req.continue({ headers });
            } catch (e) {
              try {
                req.continue();
              } catch (__) {
                /* noop */
              }
            }
          });
        } catch (e) {
          console.warn("PrintController: unable to enable request interception:", e.message || e);
        }

        // Log partial token for debugging (do not log full token in production)
        try {
          const tPreview = token.toString().slice(0, 8) + "..." + token.toString().slice(-6);
          console.log("PrintController: received token, injecting into page (preview):", tPreview);
        } catch (e) {
          /* noop */
        }
      } catch (e) {
        console.warn("Failed to set up authentication in puppeteer page:", e.message || e);
      }

      console.log("PrintController: navigating to link:", link);

      // Capture console messages from the page
      page.on("console", (msg) => {
        const type = msg.type();
        const text = msg.text();
        console.log(`[Puppeteer Console ${type}]:`, text);
      });

      // Capture page errors
      page.on("pageerror", (error) => {
        console.error("[Puppeteer Page Error]:", error.message);
      });

      // Capture failed requests
      page.on("requestfailed", (request) => {
        console.error("[Puppeteer Request Failed]:", request.url(), request.failure().errorText);
      });

      // Navigate ke halaman print - add longer timeout and wait for auth
      await page.goto(link, {
        waitUntil: "networkidle0",
        timeout: 60000,
      });

      // Wait a bit for authentication to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Quick diagnostic: verify that the expected print content is present.
      // Many SPA routes will redirect to login when auth is missing/invalid. Capture
      // a screenshot and HTML dump if the expected marker text is not found so we
      // can inspect what was rendered (login page vs actual document).
      try {
        const bodyText = await page.evaluate(() => document.body.innerText || "");
        const EXPECTED_MARKER = "Mengajukan permohonan pemusnahan untuk Limbah B3";
        if (!bodyText.includes(EXPECTED_MARKER)) {
          const safeId = requestId ? String(requestId).replace(/[^a-zA-Z0-9-_]/g, "_") : Date.now();
          const outDir = path.join(__dirname, "../../logs");
          if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
          const screenshotPath = path.join(outDir, `print_debug_${safeId}.png`);
          const htmlPath = path.join(outDir, `print_debug_${safeId}.html`);
          try {
            await page.screenshot({ path: screenshotPath, fullPage: true });
            const html = await page.content();
            fs.writeFileSync(htmlPath, html, "utf8");
            console.warn(
              `PrintController: expected marker not found. Saved screenshot -> ${screenshotPath} and HTML -> ${htmlPath}`
            );
          } catch (dumpErr) {
            console.warn("PrintController: failed to capture debug artifacts:", dumpErr.message || dumpErr);
          }
        }
      } catch (diagErr) {
        console.warn("PrintController: diagnostic check failed:", diagErr.message || diagErr);
      }

      // Inject custom styles for clean PDF output
      await page.addStyleTag({
        content: `
          /* Clean PDF styling - page is already designed for print */
          body {
            margin: 0 !important;
            padding: 0 !important;
            background: white !important;
            font-family: Verdana, sans-serif !important;
          }
          
          /* Hide any navigation or app elements that might appear */
          nav, aside, header, .sidebar, .navigation {
            display: none !important;
          }
          
          /* Page break control - prevent breaking inside important sections */
          .page-break {
            page-break-inside: avoid;
            break-inside: avoid;
          }
          
          /* Force page break before certain sections */
          .page-break-before {
            page-break-before: always;
            break-before: page;
          }
          
          /* General table styling */
          table {
            border-collapse: collapse !important;
            width: 100% !important;
          }
          
          /* Small tables should not break */
          table:not(.detail-limbah-table) {
            page-break-inside: avoid;
            break-inside: avoid;
          }
          
          /* Large detail limbah table can break across pages */
          .detail-limbah-table {
            page-break-inside: auto;
            break-inside: auto;
          }
          
          /* Prevent table rows from breaking */
          table tr {
            page-break-inside: avoid;
            break-inside: avoid;
          }
          
          /* Handle large tables that need to continue on next page */
          table thead {
            display: table-header-group;
          }
          
          table tbody {
            display: table-row-group;
          }
          
          /* Ensure table headers repeat on each page for the detail limbah table */
          .detail-limbah-table thead tr {
            page-break-after: avoid;
            break-after: avoid;
          }
          
          /* Verification section styling */
          .verification-section {
            page-break-inside: avoid;
            break-inside: avoid;
          }
          
          /* Section spacing */
          .mb-4 {
            margin-bottom: 1rem !important;
          }
          
          /* Clean checkbox rendering */
          input[type="checkbox"] {
            -webkit-appearance: checkbox !important;
            appearance: checkbox !important;
          }
          
          /* Prevent orphaned content */
          p, div {
            orphans: 3;
            widows: 3;
          }
        `,
      });

      // Determine revisi berdasarkan createdAt
      const createdDate = new Date(createdAt);

      // Format tanggal ke DD/MM/YYYY
      const formattedDate = createdDate.toLocaleDateString("id-ID", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });

      const revisi = "01";
      const kode = "FO.KL.000043";

      // Generate PDF
      const pdfBuffer = await page.pdf({
        format: "A4",
        displayHeaderFooter: true,
        printBackground: true,

        // Header template
        headerTemplate: `
          <table style="width: 85%; margin: 0 auto; font-size: 11px; border: 1px solid black; border-collapse: collapse; font-family: Verdana, sans-serif; table-layout: fixed;">
            <tr>
              <td style="border: 1px solid black; width: 140px; height: 70px; text-align: center; vertical-align: middle; padding: 5px;">
                <img src="${logoBase64}" alt="Company Logo" style="max-width: 120px; max-height: 60px;">
              </td>
              <td style="border: 1px solid black; height: 70px; text-align: center; vertical-align: middle; padding: 10px;">
                <h1 style="font-weight: bold; font-size: 16px; margin: 0; font-family: Verdana, sans-serif;">
                  Permohonan Pemusnahan Limbah B3
                </h1>
              </td>
            </tr>
          </table>
        `,

        // Footer template
        footerTemplate: `
          <table style="width: 85%; margin: 0 auto; font-size: 11px; border: 1px solid black; border-collapse: collapse; font-family: Verdana, sans-serif; table-layout: fixed;">
            <tr>
              <td style="border: 1px solid black; width: 12%; text-align: center; padding: 4px;">Nomor</td>
              <td style="border: 1px solid black; width: 15%; text-align: center; padding: 4px;">${kode}</td>
              <td style="border: 1px solid black; width: 12%; text-align: center; padding: 4px;">Tanggal</td>
              <td style="border: 1px solid black; width: 15%; text-align: center; padding: 4px;">${formattedDate}</td>
              <td style="border: 1px solid black; width: 10%; text-align: center; padding: 4px;">Revisi</td>
              <td style="border: 1px solid black; width: 8%; text-align: center; padding: 4px;">${revisi}</td>
              <td style="border: 1px solid black; width: 12%; text-align: center; padding: 4px;">Halaman</td>
              <td style="border: 1px solid black; width: 16%; text-align: center; padding: 4px;">
                <span class="pageNumber"></span> dari <span class="totalPages"></span>
              </td>
            </tr>
          </table>
        `,

        // Margins
        margin: {
          top: "120px",
          bottom: "80px",
          left: "60px",
          right: "60px",
        },
      });

      // Close browser
      await browser.close();

      // Set response headers
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename=Permohonan_Pemusnahan_${requestId}.pdf`);

      // Send PDF
      res.end(pdfBuffer);
    } catch (error) {
      console.error("Error during printPermohonanPemusnahan:", error);

      // Close browser if still open
      if (browser) {
        await browser.close();
      }

      res.status(500).json({
        success: false,
        error: "An error occurred during PDF generation.",
        message: error.message,
      });
    }
  }

  /**
   * Print Berita Acara Pemusnahan Limbah B3
   * GET /api/print-berita-acara-pemusnahan
   * Query params: link, beritaAcaraId, createdAt
   */
  static async printBeritaAcaraPemusnahan(req, res) {
    const { link, beritaAcaraId, createdAt } = req.query;

    let browser;
    try {
      // Konversi logo ke base64
      // Try multiple possible logo locations
      const possibleLogoPaths = [
        path.join(__dirname, "../../../../FE/ePemusnahanLimbah-FE/public/logo_bnw.png"),
        path.join(__dirname, "../../../ePemusnahanLimbah-FE/public/logo_bnw.png"),
        path.join(__dirname, "../../public/logo_bnw.png"),
        "C:\\inetpub\\wwwroot\\ePemusnahanLimbah-dev\\logo_bnw.png",
        path.join(__dirname, "../../../ePemusnahanLimbah-dev/logo_bnw.png"),
      ];

      let logoBase64 = "";
      let logoPath = null;

      for (const testPath of possibleLogoPaths) {
        if (fs.existsSync(testPath)) {
          logoPath = testPath;
          break;
        }
      }

      if (logoPath) {
        const logoBuffer = fs.readFileSync(logoPath);
        logoBase64 = `data:image/png;base64,${logoBuffer.toString("base64")}`;
      } else {
        console.warn("PrintController: logo_bnw.png not found in any expected location:", possibleLogoPaths);
      }

      // Launch browser
      browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });

      const page = await browser.newPage();

      // If the incoming request carried an Authorization header, pass the token
      // into the headless browser so the frontend page can authenticate itself
      // (the app uses sessionStorage/localStorage for tokens). This prevents
      // puppeteer from being redirected to the login page.
      const authHeader = req.headers.authorization || req.headers.Authorization || "";
      const token =
        authHeader && authHeader.toString().startsWith("Bearer ") ? authHeader.toString().slice(7) : authHeader;

      if (token) {
        try {
          // Inject token into localStorage/sessionStorage before any script runs
          await page.evaluateOnNewDocument((t) => {
            try {
              localStorage.setItem("token", t);
              sessionStorage.setItem("access_token", t);

              // Many SPAs also require user data in storage to recognize authenticated state.
              // Create a minimal user object that matches what the SPA expects.
              const mockUser = {
                log_NIK: "SYSTEM",
                Nama: "Print User",
                Jabatan: "System",
                role: "Pemohon",
                emp_DeptID: "SYS",
                emp_JobLevelID: "USR",
              };
              localStorage.setItem("user", JSON.stringify(mockUser));
              sessionStorage.setItem("user", JSON.stringify(mockUser));
            } catch (e) {
              // ignore storage errors
            }
          }, token);

          // Also set Authorization header for subsequent resource requests
          await page.setExtraHTTPHeaders({ Authorization: `Bearer ${token}` });

          // Enable request interception to attach Authorization header for SPA XHR/fetch calls.
          try {
            await page.setRequestInterception(true);
            page.on("request", (req) => {
              try {
                const headers = Object.assign({}, req.headers());
                if (token) headers["Authorization"] = `Bearer ${token}`;
                req.continue({ headers });
              } catch (e) {
                try {
                  req.continue();
                } catch (__) {
                  /* noop */
                }
              }
            });
          } catch (e) {
            console.warn("PrintController: unable to enable request interception:", e.message || e);
          }

          // Log partial token for debugging (do not log full token in production)
          try {
            const tPreview = token.toString().slice(0, 8) + "..." + token.toString().slice(-6);
            console.log("PrintController: received token, injecting into page (preview):", tPreview);
          } catch (e) {
            /* noop */
          }
        } catch (e) {
          console.warn("Failed to inject auth token into puppeteer page:", e.message || e);
        }
      }

      console.log("PrintController: navigating to link:", link);

      // Capture console messages from the page
      page.on("console", (msg) => {
        const type = msg.type();
        const text = msg.text();
        console.log(`[Puppeteer Console ${type}]:`, text);
      });

      // Capture page errors
      page.on("pageerror", (error) => {
        console.error("[Puppeteer Page Error]:", error.message);
      });

      // Capture failed requests
      page.on("requestfailed", (request) => {
        console.error("[Puppeteer Request Failed]:", request.url(), request.failure().errorText);
      });

      // Navigate ke halaman print - add longer timeout and wait for auth
      await page.goto(link, {
        waitUntil: "networkidle0",
        timeout: 60000,
      });

      // Wait a bit for authentication to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Quick diagnostic: verify that the expected print content is present.
      // Many SPA routes will redirect to login when auth is missing/invalid. Capture
      // a screenshot and HTML dump if the expected marker text is not found so we
      // can inspect what was rendered (login page vs actual document).
      try {
        const bodyText = await page.evaluate(() => document.body.innerText || "");
        const EXPECTED_MARKER = "Telah dilakukan proses verifikasi dan atau perusakan limbah B3";
        if (!bodyText.includes(EXPECTED_MARKER)) {
          const safeId = beritaAcaraId ? String(beritaAcaraId).replace(/[^a-zA-Z0-9-_]/g, "_") : Date.now();
          const outDir = path.join(__dirname, "../../logs");
          if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
          const screenshotPath = path.join(outDir, `print_berita_acara_debug_${safeId}.png`);
          const htmlPath = path.join(outDir, `print_berita_acara_debug_${safeId}.html`);
          try {
            await page.screenshot({ path: screenshotPath, fullPage: true });
            const html = await page.content();
            fs.writeFileSync(htmlPath, html, "utf8");
            console.warn(
              `PrintController: expected marker not found. Saved screenshot -> ${screenshotPath} and HTML -> ${htmlPath}`
            );
          } catch (dumpErr) {
            console.warn("PrintController: failed to capture debug artifacts:", dumpErr.message || dumpErr);
          }
        }
      } catch (diagErr) {
        console.warn("PrintController: diagnostic check failed:", diagErr.message || diagErr);
      }

      // Inject custom styles for clean PDF output
      await page.addStyleTag({
        content: `
          /* Clean PDF styling - page is already designed for print */
          body {
            margin: 0 !important;
            padding: 0 !important;
            background: white !important;
            font-family: Verdana, sans-serif !important;
          }
          
          /* Hide any navigation or app elements that might appear */
          nav, aside, header, .sidebar, .navigation {
            display: none !important;
          }
          
          /* Page break control - prevent breaking inside important sections */
          .page-break {
            page-break-inside: avoid;
            break-inside: avoid;
          }
          
          /* Force page break before certain sections */
          .page-break-before {
            page-break-before: always;
            break-before: page;
          }
          
          /* General table styling */
          table {
            border-collapse: collapse !important;
            width: 100% !important;
          }
          
          /* Small tables should not break */
          table:not(.daftar-pemusnahan-table) {
            page-break-inside: avoid;
            break-inside: avoid;
          }
          
          /* Large daftar pemusnahan table can break across pages */
          .daftar-pemusnahan-table {
            page-break-inside: auto;
            break-inside: auto;
          }
          
          /* Prevent table rows from breaking */
          table tr {
            page-break-inside: avoid;
            break-inside: avoid;
          }
          
          /* Handle large tables that need to continue on next page */
          table thead {
            display: table-header-group;
          }
          
          table tbody {
            display: table-row-group;
          }
          
          /* Ensure table headers repeat on each page for the daftar pemusnahan table */
          .daftar-pemusnahan-table thead tr {
            page-break-after: avoid;
            break-after: avoid;
          }
          
          /* Signature section styling */
          .signature-section {
            page-break-inside: avoid;
            break-inside: avoid;
          }
          
          /* Section spacing */
          .mb-4 {
            margin-bottom: 1rem !important;
          }
          
          /* Clean checkbox rendering */
          input[type="checkbox"] {
            -webkit-appearance: checkbox !important;
            appearance: checkbox !important;
          }
          
          /* Prevent orphaned content */
          p, div {
            orphans: 3;
            widows: 3;
          }
        `,
      });

      // Determine revisi berdasarkan createdAt
      const createdDate = new Date(createdAt);

      // Format tanggal ke DD/MM/YYYY
      const formattedDate = createdDate.toLocaleDateString("id-ID", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });

      const revisi = "01";
      const kode = "FO.KL.000041";

      // Generate PDF
      const pdfBuffer = await page.pdf({
        format: "A4",
        displayHeaderFooter: true,
        printBackground: true,

        // Header template
        headerTemplate: `
          <table style="width: 85%; margin: 0 auto; font-size: 11px; border: 1px solid black; border-collapse: collapse; font-family: Verdana, sans-serif; table-layout: fixed;">
            <tr>
              <td style="border: 1px solid black; width: 140px; height: 70px; text-align: center; vertical-align: middle; padding: 5px;">
                <img src="${logoBase64}" alt="Company Logo" style="max-width: 120px; max-height: 60px;">
              </td>
              <td style="border: 1px solid black; height: 70px; text-align: center; vertical-align: middle; padding: 10px;">
                <h1 style="font-weight: bold; font-size: 16px; margin: 0; font-family: Verdana, sans-serif;">
                  BERITA ACARA PEMUSNAHAN LIMBAH B3
                </h1>
              </td>
            </tr>
          </table>
        `,

        // Footer template
        footerTemplate: `
          <table style="width: 85%; margin: 0 auto; font-size: 11px; border: 1px solid black; border-collapse: collapse; font-family: Verdana, sans-serif; table-layout: fixed;">
            <tr>
              <td style="border: 1px solid black; width: 12%; text-align: center; padding: 4px;">Nomor</td>
              <td style="border: 1px solid black; width: 15%; text-align: center; padding: 4px;">${kode}</td>
              <td style="border: 1px solid black; width: 12%; text-align: center; padding: 4px;">Tanggal</td>
              <td style="border: 1px solid black; width: 15%; text-align: center; padding: 4px;">${formattedDate}</td>
              <td style="border: 1px solid black; width: 10%; text-align: center; padding: 4px;">Revisi</td>
              <td style="border: 1px solid black; width: 8%; text-align: center; padding: 4px;">${revisi}</td>
              <td style="border: 1px solid black; width: 12%; text-align: center; padding: 4px;">Halaman</td>
              <td style="border: 1px solid black; width: 16%; text-align: center; padding: 4px;">
                <span class="pageNumber"></span> dari <span class="totalPages"></span>
              </td>
            </tr>
          </table>
        `,

        // Margins
        margin: {
          top: "120px",
          bottom: "80px",
          left: "60px",
          right: "60px",
        },
      });

      // Close browser
      await browser.close();

      // Set response headers
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename=Berita_Acara_Pemusnahan_${beritaAcaraId}.pdf`);

      // Send PDF
      res.end(pdfBuffer);
    } catch (error) {
      console.error("Error during printBeritaAcaraPemusnahan:", error);

      // Close browser if still open
      if (browser) {
        await browser.close();
      }

      res.status(500).json({
        success: false,
        error: "An error occurred during PDF generation.",
        message: error.message,
      });
    }
  }
}

module.exports = PrintController;
