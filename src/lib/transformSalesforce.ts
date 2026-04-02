import * as XLSX from "@e965/xlsx";

export interface ForecastRow {
  "Opportunity ID": string;
  "Opportunity Name": string;
  "Opportunity Owner": string;
  Amount: string;
  "Close Date": string;
  Stage: string;
  Probability: string;
  Forecast?: string;
  Upside?: string;
}

const STAGE_PROBABILITY_MAP: Record<string, string> = {
  "closed won": "100%",
  "closed lost": "0%",
  "purchasing": "90%",
  "commercial": "75%",
  "technical": "50%",
  "discovery": "25%",
  "qualified": "5%",
  "omitted": "0%",
};

function titleCase(str: string): string {
  return str.replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.slice(1).toLowerCase());
}

function parseStage(rawStage: string): { stage: string; probability: string } {
  if (!rawStage) return { stage: "", probability: "" };
  const trimmed = rawStage.trim();

  const match = trimmed.match(/^(.+?)\s+(\d+)%?$/);
  if (match) {
    const stageName = titleCase(match[1].trim());
    const prob = match[2] + "%";
    return { stage: stageName, probability: prob };
  }

  const lower = trimmed.toLowerCase();
  for (const [key, prob] of Object.entries(STAGE_PROBABILITY_MAP)) {
    if (lower === key || lower.startsWith(key)) {
      return { stage: titleCase(trimmed), probability: prob };
    }
  }

  return { stage: titleCase(trimmed), probability: "" };
}

function excelDateToString(value: unknown): string {
  if (!value) return "";
  if (typeof value === "number") {
    const date = new Date((value - 25569) * 86400 * 1000);
    return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
  }
  return String(value);
}

export interface SkippedRow {
  rowNumber: number;
  rawValues: string[];
  reason: string;
}

export interface TransformResult {
  rows: ForecastRow[];
  skipped: SkippedRow[];
  totalRawRows: number;
}

export function transformOutputToForecast(workbook: XLSX.WorkBook): TransformResult {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rawData = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: "" });

  let headerRowIdx = -1;
  let colMap: Record<string, number> = {};

  for (let i = 0; i < rawData.length; i++) {
    const row = rawData[i];
    for (let j = 0; j < row.length; j++) {
      if (String(row[j]).trim() === "Opportunity ID") {
        headerRowIdx = i;
        for (let k = 0; k < row.length; k++) {
          const name = String(row[k]).trim();
          if (name) colMap[name] = k;
        }
        break;
      }
    }
    if (headerRowIdx >= 0) break;
  }

  if (headerRowIdx < 0) {
    throw new Error("Could not find 'Opportunity ID' column header in the uploaded file.");
  }

  const oppIdCol = colMap["Opportunity ID"];
  const oppNameCol = colMap["Opportunity Name"];
  const ownerCol = colMap["Opportunity Owner"];
  const amountCol = colMap["Amount"];
  const closeDateCol = colMap["Close Date"];
  const stageCol = colMap["Stage"];
  const forecastCol = colMap["Forecast"];
  const upsideCol = colMap["Upside"];

  const results: ForecastRow[] = [];
  const skipped: SkippedRow[] = [];
  const totalRawRows = rawData.length - headerRowIdx - 1;

  for (let i = headerRowIdx + 1; i < rawData.length; i++) {
    const row = rawData[i];
    const oppId = String(row[oppIdCol] ?? "").trim();
    const rowNum = i + 1; // 1-indexed for user display
    const rawValues = row.map(v => String(v ?? "").trim()).filter(Boolean);

    if (!oppId) {
      if (rawValues.length > 0) {
        skipped.push({ rowNumber: rowNum, rawValues, reason: "Empty Opportunity ID" });
      }
      continue;
    }
    if (oppId.startsWith("Subtotal") || oppId === "Sum" || oppId === "Count") {
      skipped.push({ rowNumber: rowNum, rawValues, reason: `Summary row (${oppId})` });
      continue;
    }
    if (/^\d+\/\d+\/\d+$/.test(oppId)) {
      skipped.push({ rowNumber: rowNum, rawValues, reason: "ID looks like a date" });
      continue;
    }
    if (!oppId.match(/^[0-9a-zA-Z]{15,18}$/)) {
      skipped.push({ rowNumber: rowNum, rawValues, reason: `Invalid ID format: "${oppId}" (expected 15-18 alphanumeric chars, got ${oppId.length})` });
      continue;
    }

    const rawStageValue = String(row[stageCol] ?? "").trim();
    const { stage, probability } = parseStage(rawStageValue);
    const amountRaw = String(row[amountCol] ?? "").trim();

    const rawForecast = forecastCol !== undefined ? row[forecastCol] : "";
    const rawUpside = upsideCol !== undefined ? row[upsideCol] : "";
    const forecastVal = rawForecast === true || String(rawForecast ?? "").trim().toUpperCase() === "TRUE";
    const upsideVal = rawUpside === true || String(rawUpside ?? "").trim().toUpperCase() === "TRUE";

    results.push({
      "Opportunity ID": oppId,
      "Opportunity Name": String(row[oppNameCol] ?? "").trim(),
      "Opportunity Owner": String(row[ownerCol] ?? "").trim(),
      Amount: amountRaw,
      "Close Date": excelDateToString(row[closeDateCol]),
      Stage: stage,
      Probability: probability,
      Forecast: forecastVal ? "TRUE" : "",
      Upside: upsideVal ? "TRUE" : "",
    });
  }

  return { rows: results, skipped, totalRawRows };
}

export function createForecastWorkbook(rows: ForecastRow[], version: string): XLSX.WorkBook {
  const ws = XLSX.utils.json_to_sheet(rows, {
    header: ["Opportunity ID", "Opportunity Name", "Opportunity Owner", "Amount", "Close Date", "Stage", "Probability", "Forecast", "Upside"],
  });

  ws["!cols"] = [
    { wch: 20 },
    { wch: 55 },
    { wch: 20 },
    { wch: 18 },
    { wch: 14 },
    { wch: 16 },
    { wch: 12 },
    { wch: 10 },
    { wch: 10 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Forecast");
  return wb;
}
