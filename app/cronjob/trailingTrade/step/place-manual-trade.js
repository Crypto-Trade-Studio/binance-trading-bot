const moment = require('moment');
const { binance, slack, PubSub } = require('../../../helpers');
const {
  getAPILimit,
  getAccountInfo,
  getAndCacheOpenOrdersForSymbol
} = require('../../trailingTradeHelper/common');
const { saveManualOrder } = require('../../trailingTradeHelper/order');

/**
 * Set message and return data
 *
 * @param {*} logger
 * @param {*} rawData
 * @param {*} processMessage
 * @returns
 */
const setMessage = (logger, rawData, processMessage) => {
  const data = rawData;

  logger.info({ data, saveLog: true }, processMessage);
  data.buy.processMessage = processMessage;
  data.buy.updatedAt = moment().utc().toDate();
  return data;
};

/**
 * Format order params for market total
 *
 * @param {*} logger
 * @param {*} side
 * @param {*} symbol
 * @param {*} orderParams
 * @returns
 */
const formatOrderMarketTotal = async (logger, side, symbol, orderParams) => {
  logger.info(
    { side, symbol, orderParams },
    'Formatting order for MARKET-TOTAL'
  );

  return {
    symbol,
    side,
    type: 'MARKET',
    quoteOrderQty: orderParams.quoteOrderQty
  };
};

/**
 * Format order params for market amount
 *
 * @param {*} logger
 * @param {*} side
 * @param {*} symbol
 * @param {*} orderParams
 * @returns
 */
const formatOrderMarketAmount = async (logger, side, symbol, orderParams) => {
  logger.info(
    { side, symbol, orderParams },
    'Formatting order for MARKET-AMOUNT'
  );

  return {
    symbol,
    side,
    type: 'MARKET',
    quantity: orderParams.marketQuantity
  };
};

/**
 * Format order params for limit order
 *
 * @param {*} logger
 * @param {*} side
 * @param {*} symbol
 * @param {*} orderParams
 * @returns
 */
const formatOrderLimit = async (logger, side, symbol, orderParams) => {
  logger.info({ side, symbol, orderParams }, 'Formatting order for LIMIT');
  return {
    symbol,
    side,
    type: 'LIMIT',
    quantity: orderParams.quantity,
    price: orderParams.price
  };
};

/**
 * Formatting order params based on side and type/marketType
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} order
 * @returns
 */
const formatOrder = async (logger, symbol, order) => {
  const { side, buy, sell } = order;

  if (side === 'buy' && buy.type === 'limit') {
    return formatOrderLimit(logger, side, symbol, buy);
  }

  if (side === 'buy' && buy.type === 'market' && buy.marketType === 'total') {
    return formatOrderMarketTotal(logger, side, symbol, buy);
  }

  if (side === 'buy' && buy.type === 'market' && buy.marketType === 'amount') {
    return formatOrderMarketAmount(logger, side, symbol, buy);
  }

  if (side === 'sell' && sell.type === 'limit') {
    return formatOrderLimit(logger, side, symbol, sell);
  }

  if (
    side === 'sell' &&
    sell.type === 'market' &&
    sell.marketType === 'total'
  ) {
    return formatOrderMarketTotal(logger, side, symbol, sell);
  }

  if (
    side === 'sell' &&
    sell.type === 'market' &&
    sell.marketType === 'amount'
  ) {
    return formatOrderMarketAmount(logger, side, symbol, sell);
  }

  throw new Error('Unknown order side/type for manual trade');
};

/**
 * Send slack message for order params
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} side
 * @param {*} order
 * @param {*} params
 */
const slackMessageOrderParams = async (logger, symbol, side, order, params) => {
  const { type: rawType, marketType } = order[side];
  let type = rawType.toUpperCase();

  if (type === 'MARKET') {
    type += ` - ${marketType.toUpperCase()}`;
  }

  logger.info(
    { side, order, params, saveLog: true },
    `The manual ${side.toUpperCase()} order will be placed.`
  );

  return slack.sendMessage(
    `${symbol} Manual ${side.toUpperCase()} Action (${moment().format(
      'HH:mm:ss.SSS'
    )}): *${type}*\n` +
      `- Order Params: \`\`\`${JSON.stringify(params, undefined, 2)}\`\`\`\n` +
      `- Current API Usage: ${getAPILimit(logger)}`
  );
};

/**
 * Send slack message for order result
 *
 * @param {*} logger
 * @param {*} symbol
 * @param {*} side
 * @param {*} order
 * @param {*} orderResult
 */
const slackMessageOrderResult = async (
  logger,
  symbol,
  side,
  order,
  orderResult
) => {
  const { type: rawType, marketType } = order[side];
  let type = rawType.toUpperCase();

  if (type === 'MARKET') {
    type += ` - ${marketType.toUpperCase()}`;
  }

  logger.info(
    { side, order, orderResult, saveLog: true },
    `The manual ${side.toUpperCase()} order has been placed.`
  );

  PubSub.publish('frontend-notification', {
    type: 'success',
    title:
      `The ${side} order for ${symbol} has been placed successfully.` +
      ` If the order is not executed, it should appear soon.`
  });

  return slack.sendMessage(
    `${symbol} Manual ${side.toUpperCase()} Result (${moment().format(
      'HH:mm:ss.SSS'
    )}): *${type}*\n` +
      `- Order Result: \`\`\`${JSON.stringify(
        orderResult,
        undefined,
        2
      )}\`\`\`\n` +
      `- Current API Usage: ${getAPILimit(logger)}`
  );
};

/**
 * Record order for monitoring
 *
 * @param {*} logger
 * @param {*} orderResult
 */
const recordOrder = async (logger, orderResult) => {
  const { symbol, orderId } = orderResult;

  // Save manual order
  logger.info({ orderResult }, 'Record  order');

  await saveManualOrder(logger, symbol, orderId, {
    ...orderResult
  });
};

/**
 * Place a manual order
 *
 * @param {*} logger
 * @param {*} rawData
 */
const execute = async (logger, rawData) => {
  const data = rawData;
  const { symbol, isLocked, action, baseAssetBalance, order } = data;

  if (isLocked) {
    logger.info({ isLocked }, 'Symbol is locked, do not process manual-trade');
    return data;
  }

  if (action !== 'manual-trade') {
    logger.info(
      `Do not process a manual order because action is not 'manual-trade'.`
    );
    return data;
  }

  // Assume order is provided with correct value
  const orderParams = await formatOrder(logger, symbol, order);
  slackMessageOrderParams(logger, symbol, order.side, order, {
    orderParams,
    baseAssetBalance
  });

  const orderResult = await binance.client.order(orderParams);

  logger.info({ orderResult }, 'Manual order result');

  await recordOrder(logger, orderResult);

  // Get open orders and update cache
  data.openOrders = await getAndCacheOpenOrdersForSymbol(logger, symbol);
  data.buy.openOrders = data.openOrders.filter(
    o => o.side.toLowerCase() === 'buy'
  );
  data.sell.openOrders = data.openOrders.filter(
    o => o.side.toLowerCase() === 'sell'
  );
  // Refresh account info
  data.accountInfo = await getAccountInfo(logger);

  slackMessageOrderResult(logger, symbol, order.side, order, orderResult);

  return setMessage(logger, data, `Placed new manual order.`);
};

module.exports = { execute };
