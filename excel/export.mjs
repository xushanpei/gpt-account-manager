import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const phoneLabels = {
  verified: '当前手机已验证（历史接码未知）',
  unverified: '当前手机未验证（历史接码未知）',
  bound: '已关联手机号（历史接码未知）',
  unknown: '未知'
};

function text(value) {
  const string = String(value ?? '');
  if (string.length > 32767) throw new Error('账号字段超过 Excel 单元格长度限制');
  return string;
}

export function createAccountWorkbook(accounts) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('账号资料', {
    views: [{ state: 'frozen', ySplit: 5, showGridLines: false }]
  });
  const widths = [32, 34, 38, 12, 40, 31];
  sheet.columns = widths.map(width => ({ width }));
  sheet.getCell('A2').value = '账号资料';
  sheet.getCell('A2').font = { name: 'Arial', size: 15, bold: true, color: { argb: 'FF26392F' } };
  sheet.getCell('A3').value = '手机状态来自账号接口，历史接码记录未知。套餐到期来自订阅权益字段，时间为北京时间。';
  sheet.getCell('A3').font = { name: 'Arial', size: 10, color: { argb: 'FF76816F' } };
  const rows = accounts.map(account => {
    const timestamp = account.subscription?.expiresAt ? Date.parse(account.subscription.expiresAt) : NaN;
    // Excel dates have no timezone. Shift the timestamp to display Beijing time.
    const expiry = Number.isFinite(timestamp) ? new Date(timestamp + 8 * 3600000) : account.subscription?.status === 'not_applicable' ? '不适用' : '未知';
    return [text(account.email), text(account.password), text(account.twofa), text(account.plan === 'unknown' || !account.plan ? '未知' : account.plan), phoneLabels[account.phone?.status] || '未知', expiry];
  });
  sheet.addTable({
    name: 'AccountRecords', ref: 'A5', headerRow: true,
    style: { theme: 'TableStyleLight1', showRowStripes: false },
    columns: ['账号', '密码', '2FA', '套餐', '是否接码', '套餐到期时间（北京时间）'].map(name => ({ name, filterButton: true })),
    rows
  });
  for (let rowNumber = 5; rowNumber <= rows.length + 5; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    row.height = rowNumber === 5 ? 30 : 27;
    row.eachCell(cell => {
      cell.font = { name: 'Arial', size: 10, color: { argb: 'FF26392F' } };
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
      if (rowNumber === 5) {
        cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF345941' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
      } else {
        // Assigning strings (never formula objects) preserves passwords verbatim.
        cell.numFmt = cell.col === 6 ? 'yyyy-mm-dd hh:mm:ss' : '@';
      }
    });
  }
  return workbook;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const workbook = createAccountWorkbook(JSON.parse(Buffer.concat(chunks).toString()));
    process.stdout.write(Buffer.from(await workbook.xlsx.writeBuffer()));
  } catch {
    // Raw account data and credentials must never appear in process logs.
    process.stderr.write('Excel 文件生成失败\n');
    process.exitCode = 1;
  }
}
