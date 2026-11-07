'use strict';

function monthlyPeriods(startDate, endDate) {
  for (const date of [startDate, endDate]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date) throw new Error('Invalid report date.');
  }
  if (startDate > endDate) throw new Error('Report start date must precede its end date.');
  const periods = [];
  let cursor = startDate.slice(0, 7) + '-01';
  while (cursor <= endDate) {
    const [year, month] = cursor.split('-').map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    periods.push({
      startDate: cursor < startDate ? startDate : cursor,
      endDate: lastDay > endDate ? endDate : lastDay,
      label: new Date(cursor).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
    });
    cursor = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  }
  return periods;
}

// Build columns from actual monthly reports, preserving account identity even
// when an account is renamed or has no activity in some months.
function buildMonthlyProfitAndLoss(report, total, months) {
  function cents(value) {
    if (!Number.isSafeInteger(value)) throw new Error('Invalid monthly LedgerHQ amount.');
    return value;
  }
  function cells(label, values, totalValue) {
    const sum = values.reduce((sum, value) => sum + cents(value), 0);
    if (sum !== cents(totalValue)) {
      throw new Error('LedgerHQ monthly figures do not match the period total. Refresh the report to try again.');
    }
    return [{ value: label }, ...values.concat(totalValue).map(value => ({ value: (value / 100).toFixed(2) }))];
  }
  for (const month of months) {
    if (month.data.basis !== total.basis) throw new Error('LedgerHQ report basis changed. Refresh the report to try again.');
  }
  const rows = ['revenue', 'expenses'].map(sectionKey => {
    const sectionName = sectionKey === 'revenue' ? 'Revenue' : 'Expenses';
    const accounts = new Map();
    const keyOf = account => account.accountId || account.code || account.name;
    const index = section => new Map(section.accounts.map(account => [keyOf(account), account]));
    const totals = index(total[sectionKey]);
    const monthly = months.map(month => index(month.data[sectionKey]));
    for (const map of [totals, ...monthly]) {
      for (const [key, account] of map) if (!accounts.has(key)) accounts.set(key, account);
    }
    const amount = account => account ? cents(account.balanceCents ?? account.amountCents) : 0;
    return {
      type: 'Section',
      Header: { ColData: [{ value: sectionName }] },
      Rows: { Row: [...accounts].map(([key, account]) => ({
        type: 'Data',
        ColData: cells(account.name, monthly.map(map => amount(map.get(key))), amount(totals.get(key))),
      })) },
      Summary: { ColData: cells(`Total ${sectionName}`, months.map(month => month.data[sectionKey].totalCents), total[sectionKey].totalCents) },
    };
  });
  rows.push({ type: 'Section', Summary: { ColData: cells('Net Income', months.map(month => month.data.netIncomeCents), total.netIncomeCents) } });
  return {
    ...report,
    Columns: { Column: [
      { ColTitle: 'Account', ColType: 'Account' },
      ...months.map(month => ({ ColTitle: month.label, ColType: 'Money', MetaData: [
        { Name: 'StartDate', Value: month.startDate }, { Name: 'EndDate', Value: month.endDate },
      ] })),
      { ColTitle: 'Total', ColType: 'Money' },
    ] },
    Rows: { Row: rows },
  };
}

module.exports = { monthlyPeriods, buildMonthlyProfitAndLoss };
