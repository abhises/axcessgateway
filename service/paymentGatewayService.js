import scylla_db from "../utils/ScyllaDb.js";

const table_names = {
  sessions: "paymentGateway_sessions",
  transactions: "paymentGateway_transactions",
  tokens: "paymentGateway_tokens",
  schedules: "paymentGateway_schedules",
  webhooks: "paymentGateway_webhooks",
};

const gsi_attribute_names = {
  subscription_pk: "#gsi_subscription_pk",
  order_pk: "#gsi_order_pk",
  status_pk: "#gsi_status_pk",
  expiry_pk: "#gsi_expiry_pk",
};

const gsi_index_names = {
  subscription_gsi: "gsi1",
  order_gsi: "gsi1",
  status_gsi: "gsi1",
  expiry_gsi: "gsi1",
};

class paymentGatewayService {
  /**
   * Get all transactions for a user in a date range
   * @param {string} user_id - required
   * @param {string} start_date - optional
   * @param {string} end_date - optional
   *
   *
   */

  constructor() {
    // Optionally load table configs here if not already loaded
    scylla_db.loadTableConfigs("./tables.json");
  }

  static async get_user_transactions(user_id, start_date, end_date) {
    const key = `user#${user_id}`;
    const expressionNames = { "#pk": "pk" };
    const expressionValues = { ":pk": key };
    const queryOptions = {
      ExpressionAttributeNames: expressionNames,
    };

    // ✅ Validate date range
    if (start_date && end_date) {
      const startTime = new Date(start_date).getTime();
      const endTime = new Date(end_date).getTime();

      if (isNaN(startTime) || isNaN(endTime)) {
        throw new Error("Invalid date format.");
      }

      if (startTime > endTime) {
        // Graceful fallback
        return [];
      }

      expressionValues[":start"] = start_date;
      expressionValues[":end"] = end_date;
      queryOptions.FilterExpression = "created_at BETWEEN :start AND :end";
    }

    return scylla_db.query(
      table_names.transactions,
      "#pk = :pk",
      expressionValues,
      queryOptions
    );
  }

  /**
   * Get all schedules for a user in a date range
   * @param {string} user_id - required
   * @param {string} start_date - optional
   * @param {string} end_date - optional
   */
  static async get_user_schedules(user_id, start_date, end_date) {
    const key = `user#${user_id}`;
    const expressionNames = { "#pk": "pk" };
    const expressionValues = { ":pk": key };
    const queryOptions = { ExpressionAttributeNames: expressionNames };

    // 🛑 Validate date order before applying filter
    if (start_date && end_date) {
      const start = new Date(start_date);
      const end = new Date(end_date);
      if (start > end) {
        console.warn(
          "⚠️ get_user_schedules: start_date is after end_date. Returning empty array."
        );
        return [];
      }

      expressionValues[":start"] = start_date;
      expressionValues[":end"] = end_date;
      queryOptions.FilterExpression = "created_at BETWEEN :start AND :end";
    }

    return scylla_db.query(
      table_names.schedules,
      "#pk = :pk",
      expressionValues,
      queryOptions
    );
  }

  /**
   * Get all schedules for a subscription in a date range
   * @param {string} subscription_id - required
   * @param {string} start_date - optional
   * @param {string} end_date - optional
   */
  static async get_subscription_schedules(
    subscription_id,
    start_date,
    end_date
  ) {
    const expressionValues = {
      ":subscriptionId": subscription_id, // e.g. "sub#5037"
    };

    const expressionNames = {
      "#subscriptionId": "subscriptionId",
    };

    let keyCondition = "#subscriptionId = :subscriptionId";

    if (start_date && end_date) {
      const start = new Date(start_date);
      const end = new Date(end_date);
      if (isNaN(start) || isNaN(end) || start > end) {
        console.warn("⚠️ Invalid date range. Returning []");
        return [];
      }

      // Only add these if date filter is present
      expressionValues[":start"] = start.toISOString();
      expressionValues[":end"] = end.toISOString();

      expressionNames["#created_at"] = "created_at"; // ✅ only now
      keyCondition += " AND #created_at BETWEEN :start AND :end";
    }

    const queryOptions = {
      IndexName: "subscription_gsi",
      ExpressionAttributeNames: expressionNames,
    };

    // 🔍 Debug
    // console.log("🔎 get_subscription_schedules DEBUG:");
    // console.log("Table:", table_names.schedules);
    // console.log("KeyCondition:", keyCondition);
    // console.log("ExpressionAttributeValues:", expressionValues);
    // console.log("ExpressionAttributeNames:", expressionNames);
    // console.log("QueryOptions:", queryOptions);

    return scylla_db.query(
      table_names.schedules,
      keyCondition,
      expressionValues,
      queryOptions
    );
  }

  /**
   * Get all transactions for an order in a date range
   * @param {string} order_id - required
   * @param {string} start_date - optional
   * @param {string} end_date - optional
   */
  static async get_order_transactions(order_id, start_date, end_date) {
    // Construct expression values and names for the query
    const expressionValues = {
      ":orderId": order_id, // GSI hash key value
    };

    const expressionNames = {
      "#order_id": "order_id", // GSI partition key
    };

    // Base KeyConditionExpression
    let keyCondition = "#order_id = :orderId";

    // Optional: add date range filtering using sort key (created_at)
    if (start_date && end_date) {
      const start = new Date(start_date);
      const end = new Date(end_date);

      if (isNaN(start) || isNaN(end) || start > end) {
        console.warn("⚠️ Invalid date range provided. Returning empty result.");
        return [];
      }

      // Add created_at as range key in the key condition
      expressionValues[":start"] = start.toISOString();
      expressionValues[":end"] = end.toISOString();

      expressionNames["#created_at"] = "created_at";
      keyCondition += " AND #created_at BETWEEN :start AND :end";
    }

    // GSI query options
    const queryOptions = {
      IndexName: "order_gsi",
      ExpressionAttributeNames: expressionNames,
    };

    // Optional debug output
    // console.log("🔍 get_order_transactions DEBUG");
    // console.log("KeyCondition:", keyCondition);
    // console.log("ExpressionAttributeValues:", expressionValues);
    // console.log("ExpressionAttributeNames:", expressionNames);
    // console.log("QueryOptions:", queryOptions);

    // Execute query
    return scylla_db.query(
      table_names.transactions,
      keyCondition,
      expressionValues,
      queryOptions
    );
  }

  /**
   * Get all sessions for a user in a date range
   * @param {string} user_id - required
   * @param {string} start_date - optional
   * @param {string} end_date - optional
   */
  static async get_user_sessions(user_id, start_date, end_date) {
    const expressionValues = {
      ":pk": `user#${user_id}`,
    };

    const expressionNames = {
      "#pk": "pk",
    };

    const queryOptions = {
      ExpressionAttributeNames: expressionNames,
    };

    // Add optional date filter
    if (start_date && end_date) {
      const start = new Date(start_date);
      const end = new Date(end_date);

      if (isNaN(start) || isNaN(end) || start > end) {
        console.warn("⚠️ Invalid date range. Returning []");
        return [];
      }

      expressionValues[":start"] = start.toISOString();
      expressionValues[":end"] = end.toISOString();

      expressionNames["#created_at"] = "created_at";
      queryOptions.FilterExpression = "#created_at BETWEEN :start AND :end";
    }

    // Debug
    // console.log("🔍 get_user_sessions DEBUG");
    // console.log("KeyCondition: #pk = :pk");
    // console.log("ExpressionAttributeValues:", expressionValues);
    // console.log("ExpressionAttributeNames:", expressionNames);
    // console.log("QueryOptions:", queryOptions);

    return scylla_db.query(
      table_names.sessions,
      "#pk = :pk",
      expressionValues,
      queryOptions
    );
  }

  /**
   * Get all sessions for an order in a date range
   * @param {string} order_id - required
   * @param {string} start_date - optional
   * @param {string} end_date - optional
   */
  static async get_order_sessions(order_id, start_date, end_date) {
    const expressionValues = {
      ":gsi": order_id,
    };

    const expressionNames = {
      "#gsi_order_pk": "order_id", // GSI partition key
    };

    let keyCondition = "#gsi_order_pk = :gsi";

    // Optional date filtering
    if (start_date && end_date) {
      const start = new Date(start_date);
      const end = new Date(end_date);

      if (isNaN(start) || isNaN(end) || start > end) {
        console.warn("⚠️ Invalid date range provided. Returning empty result.");
        return [];
      }

      expressionValues[":start"] = start.toISOString();
      expressionValues[":end"] = end.toISOString();

      expressionNames["#created_at"] = "created_at";
      keyCondition += " AND #created_at BETWEEN :start AND :end";
    }

    const queryOptions = {
      IndexName: "order_gsi",
      ExpressionAttributeNames: expressionNames,
    };

    // Debug log
    // console.log("🔍 get_order_sessions DEBUG");
    // console.log("KeyCondition:", keyCondition);
    // console.log("ExpressionAttributeValues:", expressionValues);
    // console.log("ExpressionAttributeNames:", expressionNames);
    // console.log("QueryOptions:", queryOptions);

    return scylla_db.query(
      table_names.sessions,
      keyCondition,
      expressionValues,
      queryOptions
    );
  }

  /**
   * Get all tokens for a user
   * @param {string} user_id - required
   */
  static async get_user_tokens(user_id) {
    return scylla_db.query(
      table_names.tokens,
      "#pk = :pk", // Using placeholder
      { ":pk": `user#${user_id}` }, // ExpressionAttributeValues
      {
        ExpressionAttributeNames: { "#pk": "pk" }, // REQUIRED!
      }
    );
  }

  /**
   * Get all tokens soon to expire
   * @param {string} yyyy_mm - required (e.g. '2025-07')
   */
  static async get_tokens_soon_to_expire(yyyy_mm) {
    const expressionValues = {
      ":gsi": yyyy_mm,
    };

    const expressionNames = {
      "#expiry": "expiry",
    };

    const keyCondition = "#expiry = :gsi";

    const queryOptions = {
      IndexName: "expiry_gsi",
      ExpressionAttributeNames: expressionNames,
    };

    return scylla_db.query(
      table_names.tokens,
      keyCondition,
      expressionValues,
      queryOptions
    );
  }

  /**
   * Get all failed transactions by date range
   * @param {string} start_date - optional
   * @param {string} end_date - optional
   */
  static async get_failed_transactions(start_date, end_date) {
    const expressionValues = {
      ":status": "status#failed",
    };

    const expressionNames = {
      "#statusGSI": "statusGSI",
    };

    let keyCondition = "#statusGSI = :status";

    if (start_date && end_date) {
      const start = new Date(start_date);
      const end = new Date(end_date);

      if (isNaN(start) || isNaN(end) || start > end) {
        console.warn("⚠️ Invalid date range. Returning []");
        return [];
      }

      expressionValues[":start"] = start.toISOString();
      expressionValues[":end"] = end.toISOString();
      expressionNames["#created_at"] = "created_at";

      keyCondition += " AND #created_at BETWEEN :start AND :end";
    }

    const queryOptions = {
      IndexName: "status_gsi",
      ExpressionAttributeNames: expressionNames,
    };

    // 🔍 Debug
    console.log("🔍 get_failed_transactions DEBUG");
    console.log("KeyCondition:", keyCondition);
    console.log("Values:", expressionValues);
    console.log("Names:", expressionNames);
    console.log("Options:", queryOptions);

    return scylla_db.query(
      table_names.transactions,
      keyCondition,
      expressionValues,
      queryOptions
    );
  }

  /**
   * Get all webhooks for an order
   * @param {string} order_id - required
   */
  static async get_order_webhooks(order_id) {
    return scylla_db.query(
      table_names.webhooks,
      "#pk = :pk",
      {
        ":pk": `order#${order_id}`,
      },
      {
        ExpressionAttributeNames: {
          "#pk": "pk",
        },
      }
    );
  }

  /**
   * Get all webhooks for a subscription
   * @param {string} subscription_id - required
   */
  static async get_subscription_webhooks(subscription_id) {
    const expressionValues = {
      ":subId": subscription_id,
    };

    const expressionNames = {
      "#subscriptionId": "subscriptionId",
    };

    const keyCondition = "#subscriptionId = :subId";

    const queryOptions = {
      IndexName: "subscription_gsi",
      ExpressionAttributeNames: expressionNames,
    };

    // 🔍 Full Debug Output
    // console.log("\n🔎 get_subscription_webhooks DEBUG:");
    // console.log("Table:", table_names.webhooks);
    // console.log("KeyConditionExpression:", keyCondition);
    // console.log("ExpressionAttributeValues:", expressionValues);
    // console.log("ExpressionAttributeNames:", expressionNames);
    // console.log("QueryOptions:", queryOptions);

    try {
      const result = await scylla_db.query(
        table_names.webhooks,
        keyCondition,
        expressionValues,
        queryOptions
      );
      console.log("✅ Query result:", result);
      return result;
    } catch (error) {
      console.error("❌ Query failed:", error.message || error);
      throw error;
    }
  }

  /**
   * Get all records (transactions, sessions, schedules) for a specific order
   * @param {string} order_id - required
   */
  static async get_order_full_data(order_id) {
    const expressionNames = {
      "#order_id": "order_id", // Must match your GSI key name
      "#created_at": "created_at",
    };

    const expressionValues = {
      ":order_id": `order#${order_id}`, // Ensure this matches your seeded data
      ":start": "2000-01-01T00:00:00.000Z", // Safe default for full range
      ":end": new Date().toISOString(),
    };

    const keyCondition =
      "#order_id = :order_id AND #created_at BETWEEN :start AND :end";

    const options = {
      IndexName: "order_gsi",
      ExpressionAttributeNames: expressionNames,
    };

    console.log("🔍 get_order_full_data DEBUG (Schedules)");
    console.log("KeyConditionExpression:", keyCondition);
    console.log("ExpressionAttributeValues:", expressionValues);
    console.log("ExpressionAttributeNames:", expressionNames);
    console.log("IndexName:", options.indexName);

    const [txns, sessions, schedules] = await Promise.all([
      this.get_order_transactions(order_id, null, null),
      this.get_order_sessions(order_id, null, null),
      scylla_db.query(
        table_names.schedules,
        keyCondition,
        expressionValues,
        options
      ),
    ]);

    // console.log("📦 Result Summary:");
    // console.log("→ Transactions:", txns.length);
    // console.log("→ Sessions:", sessions.length);
    // console.log("→ Schedules:", schedules.length);

    return { txns, sessions, schedules };
  }

  /**
   * Save a session record
   * @param {object} sessionData
   * @property {string} userId - required
   * @property {string} orderId - required
   * @property {string} sessionType - required ('card' | 'token')
   * @property {string} gateway - required
   * @property {string} status - required ('pending' | 'completed')
   * @property {object} payloads - required ({ requestData, responseData })
   * @property {string} [transactionId] - optional
   * @property {string} [redirectUrl] - optional
   * @property {string} [createdAt] - optional (ISO8601)
   */
  static async saveSession(sessionData) {
    // console.log("Saving session:", sessionData);
    return scylla_db.putItem(table_names.sessions, sessionData);
  }

  /**
   * Update a session record
   * @param {string} pk - required, partition key
   * @param {string} sk - required, sort key
   * @param {object} updates - required, fields to update
   */
  static async updateSession(pk, sk, updates) {
    return scylla_db.updateItem(table_names.sessions, { pk, sk }, updates);
  }

  /**
   * Delete a session record
   * @param {string} pk - required, partition key
   * @param {string} sk - required, sort key
   */
  static async deleteSession(pk, sk) {
    return scylla_db.deleteItem(table_names.sessions, { pk, sk });
  }

  /**
   * Save a transaction record
   * @param {object} transactionData
   * @property {string} userId - required
   * @property {string} orderId - required
   * @property {string} transactionId - required
   * @property {string} orderType - required
   * @property {string} status - required ('success' | 'failed')
   * @property {object} payloads - required ({ requestData, responseData })
   * @property {string} [cardLast4] - optional
   * @property {string} [cardType] - optional
   * @property {string} [cardHolderName] - optional
   * @property {string} [tokenId] - optional
   * @property {string} [createdAt] - optional
   */
  static async saveTransaction(transactionData) {
    return scylla_db.putItem(table_names.transactions, transactionData);
  }

  /**
   * Update a transaction record
   * @param {string} pk - required
   * @param {string} sk - required
   * @param {object} updates - required
   */
  static async updateTransaction(pk, sk, updates) {
    // console.log("item inside ", pk, sk, updates);
    return scylla_db.updateItem(table_names.transactions, { pk, sk }, updates);
  }

  /**
   * Delete a transaction record
   * @param {string} pk - required
   * @param {string} sk - required
   */
  static async deleteTransaction(pk, sk) {
    return scylla_db.deleteItem(table_names.transactions, { pk, sk });
  }

  /**
   * Save a schedule record
   * @param {object} scheduleData
   * @property {string} userId - required
   * @property {string} orderId - required
   * @property {string} subscriptionId - required
   * @property {string} status - required
   * @property {string} frequency - required
   * @property {string} amount - required
   * @property {string} currency - required
   * @property {string} registrationId - required
   * @property {string} startDate - required
   * @property {string} nextScheduleDate - required
   * @property {string} [checkoutId] - optional
   * @property {object} [createScheduleArgs] - optional
   * @property {object} [createScheduleResponse] - optional
   * @property {string} [notes] - optional
   * @property {string} [createdAt] - optional
   */
  static async saveSchedule(scheduleData) {
    return scylla_db.putItem(table_names.schedules, scheduleData);
  }

  /**
   * Update a schedule record
   * @param {string} pk - required
   * @param {string} sk - required
   * @param {object} updates - required
   */
  static async updateSchedule(pk, sk, updates) {
    console.log("item inside ", pk, sk, updates);
    return scylla_db.updateItem(table_names.schedules, { pk, sk }, updates);
  }

  /**
   * Delete a schedule record
   * @param {string} pk - required
   * @param {string} sk - required
   */
  static async deleteSchedule(pk, sk) {
    return scylla_db.deleteItem(table_names.schedules, { pk, sk });
  }

  /**
   * Save a webhook record
   * @param {object} webhookData
   * @property {string} orderId - required
   * @property {object} payload - required
   * @property {string} actionTaken - required
   * @property {boolean} handled - required
   * @property {string} idempotencyKey - required
   * @property {string} [subscriptionId] - optional
   * @property {string} [createdAt] - optional
   */
  static async saveWebhook(webhookData) {
    return scylla_db.putItem(table_names.webhooks, webhookData);
  }

  /**
   * Update a webhook record
   * @param {string} pk - required
   * @param {string} sk - required
   * @param {object} updates - required
   */
  static async updateWebhook(pk, sk, updates) {
    return scylla_db.updateItem(table_names.webhooks, { pk, sk }, updates);
  }

  /**
   * Delete a webhook record
   * @param {string} pk - required
   * @param {string} sk - required
   */
  static async deleteWebhook(pk, sk) {
    return scylla_db.deleteItem(table_names.webhooks, { pk, sk });
  }

  /**
   * Save a token record
   * @param {object} tokenData
   * @property {string} userId - required
   * @property {string} registrationId - required
   * @property {string} last4 - required
   * @property {string} expiry - required (YYYY-MM)
   * @property {string} name - required
   * @property {string} type - required
   * @property {string} [createdAt] - optional
   */
  static async saveToken(tokenData) {
    return scylla_db.putItem(table_names.tokens, tokenData);
  }

  /**
   * Update a token record
   * @param {string} pk - required
   * @param {string} sk - required
   * @param {object} updates - required
   */
  static async updateToken(pk, sk, updates) {
    return scylla_db.updateItem(table_names.tokens, { pk, sk }, updates);
  }

  /**
   * Delete a token record
   * @param {string} pk - required
   * @param {string} sk - required
   */
  static async deleteToken(pk, sk) {
    return scylla_db.deleteItem(table_names.tokens, { pk, sk });
  }
}

export default paymentGatewayService;
