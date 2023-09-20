const moment = require('moment');
const tarkovData = require('../modules/tarkov-data');
const remoteData = require('../modules/remote-data');
const DataJob = require('../modules/data-job');

const skipOffers = {
    jaeger: {
        1: [
            '59e0d99486f7744a32234762', // Bloodhounds
        ],
    },
    mechanic: {
        1: [
            '5656eb674bdc2d35148b457c', // Failed Setup
            '62e7e7bbe6da9612f743f1e0', // Failed Setup
            '6357c98711fb55120211f7e1', // Failed Setup
            '5ede475b549eed7c6d5c18fb', // Failed Setup
        ],
        3: [
            '5b07db875acfc40dc528a5f6' // AR-15 Tactical Dynamics Skeletonized pistol grip
        ],
    },
    skier: {
        1: [
            '584148f2245977598f1ad387', // skier doesn't sell mp-133
            '5efb0da7a29a85116f6ea05f', // Hint
            '5b2388675acfc4771e1be0be', // Cocktail Tasting
            '618ba27d9008e4636a67f61d', // Cocktail Tasting
            '5b3b99475acfc432ff4dcbee', // Cocktail Tasting
        ],
    },
};

class UpdateTraderPricesJob extends DataJob {
    constructor() {
        super('update-trader-prices');
        this.writeFolder = 'cache';
        this.kvName = 'trader_price_data';
    }

    async run() {
        this.currencyId = {
            'RUB': '5449016a4bdc2d6f028b456f',
            'USD': '5696686a4bdc2da3298b456a',
            'EUR': '569668774bdc2da2298b4568'
        };
        [this.tasks, this.traders, this.traderAssorts, this.items, this.credits, this.en] = await Promise.all([
            this.jobManager.jobOutput('update-quests', this),
            this.jobManager.jobOutput('update-traders', this),
            this.jobManager.jobOutput('update-trader-assorts', this, true),
            remoteData.get(),
            tarkovData.credits(),
            tarkovData.locale('en'),
        ]);
        this.cashOffers = {};
        const lastOfferScan = await this.query(`
            SELECT 
                * 
            FROM 
                trader_offer_scan 
            WHERE 
                ended IS NOT NULL 
            ORDER BY 
                id DESC LIMIT 1
        `).then(result => {
            if (result.length === 0) {
                return Promise.reject('No completed trader scans');
            }
            return result[0];
        });
        const offers = await this.query(`
            SELECT 
                *
            FROM 
                trader_offers 
            WHERE 
                last_scan >= ?
        `, [lastOfferScan.started]);
        this.offerRequirements = await this.query(`SELECT * FROM trader_offer_requirements`);
        this.getCurrencyValues(offers);
        for (const offer of offers) {
            if (!offer.price) {
                continue;
            }
            if (this.skipOffer(offer)) {
                continue;
            }
            const item = this.items.get(offer.item_id);
            if (item.types.includes('disabled')) {
                this.logger.warn(`Skipping disabled item ${item.name} ${item.id}`);
                continue;
            }
            const trader = this.traders.find(t => t.id === offer.trader_id);
            const questUnlock = this.getQuestUnlock(offer);
            const assort = this.traderAssorts[trader.id].find(assort => assort.id === offer.id);
            const cashPrice = {
                id: offer.item_id,
                item_name: item.name,
                vendor: {
                    trader: trader.id,
                    trader_id: trader.id,
                    traderLevel: offer.min_level,
                    minTraderLevel: offer.min_level,
                    taskUnlock: questUnlock?.id,
                },
                source: trader.normalizedName,
                price: Math.round(offer.price), // prices in API are Int; we should convert to float
                priceRUB: Math.round(offer.price * this.currencyValues[offer.currency]),
                updated: offer.updated,
                quest_unlock: Boolean(questUnlock),
                quest_unlock_id: questUnlock ? questUnlock.id : null,
                currecy: offer.currency,
                currencyItem: this.currencyId[offer.currency],
                requirements: [
                    {
                        type: 'loyaltyLevel',
                        value: offer.min_level,
                    }
                ],
                restockAmount: assort ? assort.stock : offer.restock_amount,
                buyLimit: offer.buy_limit,
                traderOfferId: offer.id,
            };
            if (questUnlock) {
                cashPrice.requirements.push({
                    type: 'questCompleted',
                    value: questUnlock.tarkovDataId,
                    stringValue: questUnlock.id,
                });
            }
            if (!this.cashOffers[offer.item_id]) {
                this.cashOffers[offer.item_id] = [];
            }
            this.cashOffers[offer.item_id].push(cashPrice);
        }
        const priceData = {
            TraderCashOffer: this.cashOffers,
        };
        await this.cloudflarePut(priceData);
        return priceData;
    }

    getCurrencyValues = (offers) => {
        this.currencyValues = {
            RUB: 1,
        }
        const currencies = {
            USD: {
                id: '5696686a4bdc2da3298b456a',
                multiplier: 1.104271357,
            },
            EUR: {
                id: '569668774bdc2da2298b4568',
                multiplier: 1.152974504,
            }
        };
        for (const currencyCode in currencies) {
            const itemId = currencies[currencyCode].id;
            let price = Math.round(this.credits[itemId] * currencies[currencyCode].multiplier)
            const offer = offers.find(o => o.item_id === itemId);
            if (offer) {
                price = offer.price;
            } else {
                this.logger.warn(`Could not find trader price for currency ${currencyCode}`);
            }
            this.currencyValues[currencyCode] = price;
        }
    };

    getQuestUnlock = (offer) => {
        if (!offer.locked) {
            return null;
        }
        const trader = this.traders.find(t => t.id === offer.trader_id);
        const itemId = offer.item_id;
        for (const quest of this.tasks) {
            const match = unlockMatches(itemId, quest.startRewards, trader.id) || unlockMatches(itemId, quest.finishRewards, trader.id);
            if (match) {
                return {
                    id: quest.id,
                    tarkovDataId: quest.tarkovDataId,
                    level: match.level
                };
            }
        }
        this.logger.warn(`Could not find quest unlock for trader offer ${offer.id}: ${trader.normalizedName} ${offer.min_level} ${this.items.get(itemId).name} ${itemId}`);
        return null;
    }

    getTraderByName = (traderName) => {
        return this.traders.find(t => this.locales.en[t.name].toLowerCase() === traderName.toLowerCase());
    }

    skipOffer = (offer) => {
        const trader = this.traders.find(t => t.id === offer.trader_id);
        if (!skipOffers[trader.normalizedName]) {
            return false;
        }
        if (!skipOffers[trader.normalizedName][offer.min_level]) {
            return false;
        }
        if (!skipOffers[trader.normalizedName][offer.min_level].includes(offer.item_id)) {
            return false;
        }
        return true;
    }
}

const unlockMatches = (itemId, rewards, traderId) => {
    if (!rewards || !rewards.offerUnlock) return false;
    for (const unlock of rewards.offerUnlock) {
        if (unlock.trader_id !== traderId) continue;
        if (unlock.item === itemId) return unlock;
        if (unlock.base_item_id && unlock.base_item_id === itemId) return unlock;
    }
    return false;
};

module.exports = UpdateTraderPricesJob;
