export default class PaymentGatewayServiceMock {
  constructor() {
    this.sessions = [];
    this.transactions = [];
    this.schedules = new Map();
    this.tokens = new Map();
    this.webhooks = [];
    this.verifications = [];
    this.grants = [];
    this.denials = [];
    this.resume = [];
    this.downgrades = [];
    this.orderHistory = new Map();
  }

  // sessions
  async saveSession(s) {
    const existingIndex = this.sessions.findIndex((x) => x.id === s.id);
    if (existingIndex >= 0) this.sessions[existingIndex] = s;
    else this.sessions.push(s);
    return s;
  }
  async getSessionsBy(key, val) {
    return this.sessions.filter((s) => s[key] === val);
  }
  async deleteSession(id) {
    const i = this.sessions.findIndex((s) => s.id === id);
    if (i >= 0) this.sessions.splice(i, 1);
    return true;
  }

  // transactions
  async saveTransaction(t) {
    this.transactions.push(t);
    return t;
  }
  async updateTransactionStatus(t) {
    this.transactions.push({ ...t, updated: true });
  }
  async cancelTransaction(t) {
    this.transactions.push({ ...t, status: "canceled" });
  }
  async refundTransaction(t) {
    this.transactions.push({ ...t, status: "refunded" });
  }

  // entitlements
  async grantAccess(payload) {
    this.grants.push(payload);
  }
  async denyAccess(payload) {
    this.denials.push(payload);
  }
  async applyGrace(payload) {
    this.denials.push({ ...payload, grace: true });
  }

  // schedules (subscriptions)
  async upsertSchedule(s) {
    const id =
      s.scheduleId || s.subscriptionId || `S-${this.schedules.size + 1}`;
    this.schedules.set(id, { ...s, scheduleId: id });
  }
  async cancelSchedule(id) {
    if (this.schedules.has(id)) {
      const s = this.schedules.get(id);
      s.status = "canceled";
      this.schedules.set(id, s);
    }
  }
  async saveResumeInstruction(instr) {
    this.resume.push(instr);
  }
  async saveDowngradeInstruction(instr) {
    this.downgrades.push(instr);
  }

  // tokens
  async saveToken(t) {
    this.tokens.set(t.id, t);
  }
  async updateToken(t) {
    this.tokens.set(t.id, { ...(this.tokens.get(t.id) || {}), ...t });
  }
  async deleteToken(id) {
    this.tokens.delete(id);
  }
  async getTokensByUser(userId) {
    return [...this.tokens.values()].filter(
      (t) => t.userId === userId || t.user_id === userId
    );
  }
  async getTokensByExpiry(yyyymm) {
    return [...this.tokens.values()].filter((t) =>
      (t.expiry || "").startsWith(yyyymm)
    );
  }

  // webhooks & verification
  async saveWebhook(w) {
    this.webhooks.push(w);
  }
  async saveVerification(v) {
    this.verifications.push(v);
  }

  async getOrderHistory(orderId) {
    return (
      this.orderHistory.get(orderId) || {
        sessions: [],
        transactions: [],
        schedules: [],
      }
    );
  }
}
