import { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import * as XLSX from 'xlsx';
import { Upload, Download, CheckCircle2, AlertCircle, ArrowDown, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { transformOutputToForecast, createForecastWorkbook, type ForecastRow } from '@/lib/transformSalesforce';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const SalesDataSync = () => {
  const [fileName, setFileName] = useState<string | null>(null);
  const [forecastData, setForecastData] = useState<ForecastRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(1);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (!file) return;

    setError(null);
    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const rows = transformOutputToForecast(workbook);
        if (rows.length === 0) {
          setError('No valid opportunity rows found in the file.');
          setForecastData(null);
          return;
        }
        setForecastData(rows);
      } catch (err: any) {
        setError(err.message || 'Failed to parse file.');
        setForecastData(null);
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.ms-excel': ['.xls'],
    },
    maxFiles: 1,
  });

  const handleDownload = () => {
    if (!forecastData) return;
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const timeStr = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const versionStr = `v${version}`;
    const downloadName = `Forecast_${dateStr}_${timeStr}_${versionStr}.xlsx`;

    const wb = createForecastWorkbook(forecastData, versionStr);
    XLSX.writeFile(wb, downloadName);
    setVersion((v) => v + 1);
  };

  const isReady = !!forecastData;

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-sm font-semibold">SFDC Data Sync</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Transform Salesforce exports into Forecast-ready spreadsheets
        </p>
      </div>

      {/* Step indicators */}
      <div className="mb-6 flex items-center gap-3">
        <div className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
          !isReady ? 'bg-foreground text-background' : 'bg-secondary text-foreground'
        }`}>
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-background/20 text-[10px]">1</span>
          Upload
        </div>
        <div className="h-px w-6 bg-border" />
        <div className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
          isReady ? 'bg-foreground text-background' : 'bg-secondary text-muted-foreground'
        }`}>
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-background/20 text-[10px]">2</span>
          Download
        </div>
      </div>

      {/* Cards grid */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Upload Card */}
        <div
          {...getRootProps()}
          className={`group relative cursor-pointer overflow-hidden rounded-lg border-2 border-dashed transition-all ${
            isDragActive
              ? 'border-foreground bg-secondary'
              : isReady
                ? 'border-border bg-secondary/50'
                : 'border-border bg-card hover:border-foreground/40'
          }`}
        >
          <input {...getInputProps()} />
          <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
            {isReady ? (
              <>
                <CheckCircle2 className="h-6 w-6 text-foreground mb-3" />
                <p className="text-sm font-semibold">{fileName}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{forecastData.length}</span> opportunities loaded
                </p>
                <p className="mt-3 text-[10px] text-muted-foreground bg-secondary rounded-full px-2 py-0.5">
                  Drop a new file to replace
                </p>
              </>
            ) : (
              <>
                <Upload className="h-6 w-6 text-muted-foreground mb-3 group-hover:text-foreground transition-colors" />
                <p className="text-sm font-semibold">Drop your Output file</p>
                <p className="mt-1 text-xs text-muted-foreground">Salesforce export (.xlsx)</p>
                <p className="mt-3 text-[10px] text-muted-foreground bg-secondary rounded-full px-2 py-0.5">
                  or click to browse
                </p>
              </>
            )}
          </div>
        </div>

        {/* Download Card */}
        <div className={`overflow-hidden rounded-lg border transition-all ${
          isReady ? 'border-border bg-card' : 'border-border bg-card opacity-50'
        }`}>
          <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
            <Download className={`h-6 w-6 mb-3 ${isReady ? 'text-foreground' : 'text-muted-foreground'}`} />
            <p className="text-sm font-semibold">Forecast Excel</p>
            {isReady ? (
              <>
                <p className="mt-1 text-xs text-muted-foreground">
                  Version <span className="font-medium text-foreground">v{version}</span> • timestamped
                </p>
                <Button
                  onClick={handleDownload}
                  size="sm"
                  className="mt-4 gap-1.5"
                >
                  <ArrowDown className="h-3 w-3" />
                  Download Forecast
                </Button>
              </>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">Upload a file to get started</p>
            )}
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Preview table */}
      {isReady && (
        <div className="mt-6 overflow-hidden rounded-lg border border-border">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-1.5">
              <Sparkles className="h-3 w-3 text-muted-foreground" />
              <h3 className="text-xs font-medium">Preview</h3>
            </div>
            <span className="text-[10px] text-muted-foreground font-mono">
              {forecastData.length} rows
            </span>
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-secondary/50">
                  <TableHead className="text-xs">Opp ID</TableHead>
                  <TableHead className="text-xs">Name</TableHead>
                  <TableHead className="text-xs">Owner</TableHead>
                  <TableHead className="text-xs">Amount</TableHead>
                  <TableHead className="text-xs">Close Date</TableHead>
                  <TableHead className="text-xs">Stage</TableHead>
                  <TableHead className="text-xs">Prob.</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {forecastData.slice(0, 15).map((row, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-[10px] text-muted-foreground">{row["Opportunity ID"]}</TableCell>
                    <TableCell className="max-w-[220px] truncate text-xs">{row["Opportunity Name"]}</TableCell>
                    <TableCell className="text-xs">{row["Opportunity Owner"]}</TableCell>
                    <TableCell className="text-xs font-medium">{row.Amount}</TableCell>
                    <TableCell className="text-xs">{row["Close Date"]}</TableCell>
                    <TableCell>
                      <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                        row.Stage === 'Closed Won' ? 'bg-foreground/10 text-foreground' :
                        'bg-secondary text-muted-foreground'
                      }`}>
                        {row.Stage}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs font-medium">{row.Probability}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {forecastData.length > 15 && (
              <p className="border-t border-border px-4 py-2 text-center text-[10px] text-muted-foreground">
                Showing 15 of {forecastData.length} rows — all rows included in download
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default SalesDataSync;
