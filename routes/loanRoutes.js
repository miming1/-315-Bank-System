// loanRoutes.js
const express = require('express');
const router = express.Router();
// use your existing db connection
const db = require('./db'); // adjust path to your db instance
// helper utils (we'll define below or import)
const { calculateMaxLoan, amortizationSchedule, monthlyFromPrincipal } = require('./loanUtils');

/**
 * GET /api/loan/eligibility/:userId
 * Returns deposit, savings totals, combined, and eligibility info for dynamic loan UI.
 */
router.get('/eligibility/:userId', async (req, res) => {
  const userId = req.params.userId;
  try {
    const [rows] = await db.query(
      `SELECT 
         SUM(CASE WHEN type_name='Deposit' THEN balance ELSE 0 END) AS deposit_total,
         SUM(CASE WHEN type_name='Savings' THEN balance ELSE 0 END) AS savings_total
       FROM account_type
       WHERE user_id = ?`,
      [userId]
    );

    const deposit = Number(rows[0].deposit_total || 0);
    const savings = Number(rows[0].savings_total || 0);
    const combined = deposit + savings;

    // determine eligible tiers by combined balance (optional, for UI hints)
    const eligible_tiers = [];
    if (combined >= 300000) eligible_tiers.push('tier3');
    if (combined >= 150000) eligible_tiers.push('tier2');
    if (combined >= 50000) eligible_tiers.push('tier1');

    // check if there is active loan
    const [activeLoans] = await db.query(
      `SELECT loan_id, remaining_balance, monthly_payment, status, start_date, end_date 
       FROM loans WHERE user_id = ? AND status = 'Active' LIMIT 1`,
      [userId]
    );

    return res.json({
      deposit_total: deposit,
      savings_total: savings,
      combined,
      eligible_tiers,
      activeLoan: activeLoans[0] || null
    });
  } catch (err) {
    console.error('eligibility error', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

/**
 * POST /api/loan/calculate
 * Body: { user_id, amount (optional), term_months, income, employment_status, purpose }
 * Returns maxPrincipal, allowedMonthly, monthlyPaymentForRequestedAmount, amortizationSchedule
 */
router.post('/calculate', async (req, res) => {
  try {
    const { user_id, amount, term_months, income, employment_status, purpose } = req.body;
    const userId = user_id;

    // 1) get user's credit score
    const [urows] = await db.query('SELECT credit_score FROM users WHERE user_id = ? LIMIT 1', [userId]);
    const credit_score = urows?.[0]?.credit_score ?? 300;

    // 2) fetch employment multiplier
    const [empRows] = await db.query('SELECT multiplier FROM employment_multipliers WHERE employment_status = ? LIMIT 1', [employment_status]);
    const employmentMultiplier = empRows?.[0]?.multiplier ?? 1.0;

    // 3) fetch credit multiplier
    const [tierRows] = await db.query('SELECT multiplier FROM credit_tiers WHERE ? BETWEEN min_score AND max_score LIMIT 1', [credit_score]);
    const creditMultiplier = tierRows?.[0]?.multiplier ?? 0.8;

    // 4) fetch DTI from loan_settings
    const [settRows] = await db.query('SELECT dti_ratio, base_interest_rate FROM loan_settings LIMIT 1');
    const dtiRatio = settRows?.[0]?.dti_ratio ?? 0.30;
    const baseInterest = settRows?.[0]?.base_interest_rate ?? 24; // APR percent

    // 5) compute max loanable (using baseInterest & requested term)
    const calc = calculateMaxLoan({
      income: Number(income),
      dtiRatio,
      employmentMultiplier,
      creditMultiplier,
      annualPercent: baseInterest,
      termMonths: Number(term_months)
    });

    // 6) if amount provided, compute monthly and schedule for that amount
    let monthlyForRequested = null;
    let requestedSchedule = null;
    if (amount) {
      monthlyForRequested = monthlyFromPrincipal(Number(amount), (baseInterest/100)/12, Number(term_months));
      requestedSchedule = amortizationSchedule(Number(amount), baseInterest, Number(term_months));
    }

    return res.json({
      allowedMonthly: calc.allowedMonthly,
      maxPrincipal: calc.maxPrincipal,
      monthlyForRequested: monthlyForRequested ? Number(monthlyForRequested.toFixed(2)) : null,
      requestedSchedule,
      interestRate: baseInterest,
      credit_score
    });
  } catch (err) {
    console.error('calculate error', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

/**
 * POST /api/loan/apply
 * Persist application (Pending). Validates maxPrincipal.
 * Body: { user_id, amount, term_months, income, employment_status, purpose }
 */
router.post('/apply', async (req, res) => {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const { user_id, amount, term_months, income, employment_status, purpose } = req.body;
    const userId = user_id;

    // fetch user credit score & settings (repeat calculate steps for validation)
    const [urows] = await conn.query('SELECT credit_score FROM users WHERE user_id = ? LIMIT 1', [userId]);
    const credit_score = urows?.[0]?.credit_score ?? 300;
    const [empRows] = await conn.query('SELECT multiplier FROM employment_multipliers WHERE employment_status = ? LIMIT 1', [employment_status]);
    const employmentMultiplier = empRows?.[0]?.multiplier ?? 1.0;
    const [tierRows] = await conn.query('SELECT multiplier FROM credit_tiers WHERE ? BETWEEN min_score AND max_score LIMIT 1', [credit_score]);
    const creditMultiplier = tierRows?.[0]?.multiplier ?? 0.8;
    const [settRows] = await conn.query('SELECT dti_ratio, base_interest_rate FROM loan_settings LIMIT 1');
    const dtiRatio = settRows?.[0]?.dti_ratio ?? 0.30;
    const baseInterest = settRows?.[0]?.base_interest_rate ?? 24;

    const calc = calculateMaxLoan({
      income: Number(income),
      dtiRatio,
      employmentMultiplier,
      creditMultiplier,
      annualPercent: baseInterest,
      termMonths: Number(term_months)
    });

    if (Number(amount) > Number(calc.maxPrincipal)) {
      await conn.rollback();
      conn.release();
      return res.status(400).json({ error: 'requested_amount_exceeds_max', maxPrincipal: calc.maxPrincipal });
    }

    // generate amortization schedule
    const scheduleObj = amortizationSchedule(Number(amount), baseInterest, Number(term_months));
    const repaymentScheduleJson = JSON.stringify(scheduleObj.schedule);

    // insert application
    const [insertRes] = await conn.query(
      `INSERT INTO loan_applications
        (user_id, type_id, loan_amount, loan_term_months, income, employment_status, purpose, calculated_max_loan, monthly_payment, credit_score, interest_rate, repayment_schedule, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending')`,
      [
        userId,
        1, // type_id default product
        Number(amount),
        Number(term_months),
        Number(income),
        employment_status,
        purpose,
        Number(calc.maxPrincipal),
        Number(scheduleObj.monthly_payment),
        credit_score,
        baseInterest,
        repaymentScheduleJson
      ]
    );

    const applicationId = insertRes.insertId;

    // log admin action (system)
    await conn.query(`INSERT INTO admin_actions (user_id, target_id, target_table, action_type, remarks) VALUES (?, ?, ?, 'Create', ?)`,
      [0, applicationId, 'loan_applications', 'Application submitted via API']);

    await conn.commit();
    conn.release();

    return res.json({ applicationId, monthly_payment: scheduleObj.monthly_payment, maxPrincipal: calc.maxPrincipal });
  } catch (err) {
    console.error('apply error', err);
    await conn.rollback().catch(()=>{});
    conn.release();
    return res.status(500).json({ error: 'server_error' });
  }
});

/**
 * GET /api/loan/status/:userId
 * Return active loan (if any) + application history
 */
router.get('/status/:userId', async (req, res) => {
  const userId = req.params.userId;
  try {
    const [activeLoans] = await db.query(
      `SELECT l.*, lp.payment_date AS next_due
       FROM loans l
       LEFT JOIN loan_payments lp ON lp.loan_id = l.loan_id AND lp.status = 'Pending'
       WHERE l.user_id = ? AND l.status = 'Active'
       ORDER BY lp.payment_date ASC LIMIT 1`,
      [userId]
    );

    const [history] = await db.query(
      `SELECT application_id, loan_amount, loan_term_months, status, application_date
       FROM loan_applications WHERE user_id = ? ORDER BY application_date DESC LIMIT 50`,
      [userId]
    );

    return res.json({
      activeLoan: activeLoans[0] || null,
      history: history || []
    });
  } catch (err) {
    console.error('status error', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

/**
 * GET /api/loan/history/:userId
 * Returns full payment history for user's loans
 */
router.get('/history/:userId', async (req, res) => {
  const userId = req.params.userId;
  try {
    const [payments] = await db.query(
      `SELECT p.*, l.user_id, l.principal
       FROM loan_payments p
       JOIN loans l ON l.loan_id = p.loan_id
       WHERE l.user_id = ? ORDER BY p.payment_date DESC`,
      [userId]
    );
    return res.json({ payments });
  } catch (err) {
    console.error('history error', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
