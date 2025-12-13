// loanUtils.js

function monthlyFromPrincipal(P, r, n) {
  // r must be monthly decimal (e.g., 0.02)
  if (r === 0) return P / n;
  const r1n = Math.pow(1 + r, n);
  return (P * r * r1n) / (r1n - 1);
}

function principalFromMonthly(M, r, n) {
  if (r === 0) return M * n;
  const r1n = Math.pow(1 + r, n);
  return M * ((r1n - 1) / (r * r1n));
}

/**
 * amortizationSchedule(P, annualPercent, termMonths, startDateIso)
 * annualPercent = APR as percent (e.g., 24)
 */
function amortizationSchedule(P, annualPercent, termMonths, startDateIso) {
  const monthlyR = (annualPercent / 100) / 12;
  const M = monthlyFromPrincipal(P, monthlyR, termMonths);
  const schedule = [];
  let balance = Number(P);
  let current = startDateIso ? new Date(startDateIso) : new Date();

  for (let i = 1; i <= termMonths; i++) {
    const interest = Number((balance * monthlyR).toFixed(2));
    let principalPortion = Number((M - interest).toFixed(2));
    // last payment adjustment
    if (i === termMonths) principalPortion = Number(balance.toFixed(2));
    const payment = Number((principalPortion + interest).toFixed(2));
    balance = Number((balance - principalPortion).toFixed(2));
    current.setMonth(current.getMonth() + 1);
    schedule.push({
      period: i,
      due_date: current.toISOString().slice(0,10),
      payment,
      principal: principalPortion,
      interest,
      balance: balance < 0 ? 0 : balance
    });
  }

  return { monthly_payment: Number(M.toFixed(2)), schedule };
}

/**
 * calculateMaxLoan({ income, dtiRatio, employmentMultiplier, creditMultiplier, annualPercent, termMonths })
 * returns allowedMonthly and maxPrincipal
 */
function calculateMaxLoan({ income, dtiRatio = 0.30, employmentMultiplier = 1.0, creditMultiplier = 0.8, annualPercent = 24, termMonths = 12 }) {
  const allowedMonthly = Number((income * dtiRatio * employmentMultiplier * creditMultiplier).toFixed(2));
  const monthlyR = (annualPercent / 100) / 12;
  const P = principalFromMonthly(allowedMonthly, monthlyR, termMonths);
  return { allowedMonthly, maxPrincipal: Number(P.toFixed(2)) };
}

module.exports = {
  amortizationSchedule,
  monthlyFromPrincipal,
  calculateMaxLoan
};
