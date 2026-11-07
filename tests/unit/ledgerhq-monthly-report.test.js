'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { monthlyPeriods, buildMonthlyProfitAndLoss } = require('../../server/services/ledgerhqMonthlyReport');
const account = (accountId, name, balanceCents) => ({ accountId, name, balanceCents });
const data = (accounts, expenses = []) => {
  const total = rows => rows.reduce((sum, row) => sum + row.balanceCents, 0);
  return { basis: 'cash', revenue: { accounts, totalCents: total(accounts) },
    expenses: { accounts: expenses, totalCents: total(expenses) }, netIncomeCents: total(accounts) - total(expenses) };
};
function fixture() {
  const total = data([account('a','Renamed revenue',15000),account('b','Seasonal',-1000)]);
  const months = monthlyPeriods('2026-01-01','2026-03-15').map((period,index) => ({ ...period, data: [
    data([account('a','Original revenue',10000)]),
    data([account('a','Renamed revenue',5000),account('b','Seasonal',-1000)]),
    data([]),
  ][index] }));
  return { total, months };
}

test('annual and YTD ranges produce calendar months, including leap days and partial endpoints', () => {
  assert.equal(monthlyPeriods('2025-01-01','2025-12-31').length, 12);
  const ytd = monthlyPeriods('2026-01-01','2026-09-26');
  assert.equal(ytd.length,9); assert.equal(ytd.at(-1).endDate,'2026-09-26');
  const range = monthlyPeriods('2024-02-10','2024-03-05');
  assert.equal(range[0].startDate,'2024-02-10'); assert.equal(range[0].endDate,'2024-02-29');
  assert.equal(range[1].label,'Mar 2024'); assert.equal(range[1].endDate,'2024-03-05');
  assert.throws(()=>monthlyPeriods('2025-02-30','2025-03-01'),/Invalid/);
  assert.throws(()=>monthlyPeriods('2025-03-01','2025-02-01'),/precede/);
});
test('monthly rows align account IDs through renames, inactive months and negative amounts', () => {
  const { total, months } = fixture();
  const report = buildMonthlyProfitAndLoss({ Header: { ReportName: 'Profit and Loss' } },total,months);
  assert.deepEqual(report.Columns.Column.map(c=>c.ColTitle),['Account','Jan 2026','Feb 2026','Mar 2026','Total']);
  const rows = report.Rows.Row[0].Rows.Row;
  assert.deepEqual(rows[0].ColData.map(c=>c.value),['Renamed revenue','100.00','50.00','0.00','150.00']);
  assert.deepEqual(rows[1].ColData.map(c=>c.value),['Seasonal','0.00','-10.00','0.00','-10.00']);
  assert.deepEqual(report.Rows.Row.at(-1).Summary.ColData.map(c=>c.value),['Net Income','100.00','40.00','0.00','140.00']);
  assert.equal(report.Columns.Column[3].MetaData[1].Value,'2026-03-15');
});
test('zero annual balance does not hide monthly activity or merge distinct accounts with the same name', () => {
  const periods = monthlyPeriods('2026-01-01','2026-02-28');
  const total = data([account('a','Fees',0),account('b','Fees',200)]);
  const months = periods.map((p,i)=>({...p,data:data(i === 0 ? [account('a','Fees',1000),account('b','Fees',200)] : [account('a','Fees',-1000)])}));
  const rows = buildMonthlyProfitAndLoss({},total,months).Rows.Row[0].Rows.Row;
  assert.equal(rows.length,2);
  assert.deepEqual(rows[0].ColData.map(c=>c.value),['Fees','10.00','-10.00','0.00']);
});
test('inconsistent monthly totals or accounting basis fail instead of presenting misleading figures', () => {
  const { total, months } = fixture();
  total.revenue.accounts[0].balanceCents++;
  assert.throws(()=>buildMonthlyProfitAndLoss({},total,months),/do not match/);
  total.revenue.accounts[0].balanceCents--;
  months[0].data.basis='accrual';
  assert.throws(()=>buildMonthlyProfitAndLoss({},total,months),/basis changed/);
});
