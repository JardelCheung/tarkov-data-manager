require('dotenv').config();

const mysql = require('mysql');

const getTarkovMarketData = require('../modules/tarkov-market-data');
const getTarkovMarketBSGData = require('../modules/tarkov-market-bsg-data');
const normalizeName = require('../modules/normalize-name');
const {categories} = require('../modules/category-map');

const connection = mysql.createConnection({
    host     : 'tarkov-tools-master-1.cluster-c1vhfeufwkpn.eu-west-1.rds.amazonaws.com',
    user     : 'desktop1',
    password : process.env.MYSQL_PASSWORD,
    database : 'tarkov_tools',
});

connection.connect();

const mappingProperties = [
    'BlindnessProtection',
    'MaxDurability',
    'armorClass',
    'speedPenaltyPercent',
    'mousePenalty',
    'weaponErgonomicPenalty',
    'armorZone',
    'ArmorMaterial',
    'headSegments',
    'BlocksEarpiece',
    'DeafStrength',
    'RicochetParams',
    'Accuracy',
    'Recoil',
    'Ergonomics',
    'Weight',
];

let bsgData;

const getGrid = (item) => {
    if(!item._props.Grids){
        return false;
    }

    const gridData = {
        pockets: [],
        totalSize: 0,
    };

    for(const grid of item._props.Grids){
        gridData.totalSize = gridData.totalSize + grid._props.cellsH * grid._props.cellsV;
        gridData.pockets.push({
            height: grid._props.cellsH,
            width: grid._props.cellsV
        });
    }

    return gridData;
};

const getItemCategory = (item) => {
    if(!item){
        return false;
    }

    if(!item._parent){
        return false;
    }

    // Check if parent is category
    if(categories[item._parent]){
        return categories[item._parent];
    }

    // Let's traverse
    return getItemCategory(bsgData[item._parent]);
};

module.exports = async () => {
    console.log('Running game data update');
    const items = await getTarkovMarketData();
    bsgData = await getTarkovMarketBSGData();

    for(let i = 0; i < items.length; i = i + 1){
        const item = items[i];
        console.log(`Updating ${i + 1}/${items.length}`);
        console.log(`Updating ${item._id}`);
        const extraProperties = {};
        for(const extraProp of mappingProperties){

            if(!item._props[extraProp]){
                continue;
            }

            extraProperties[extraProp] = item._props[extraProp];
        }

        extraProperties.grid = getGrid(item);

        const itemCategory = getItemCategory(item);

        extraProperties.bsgCategoryId = itemCategory?.id || item._parent;

        const promise = new Promise((resolve, reject) => {
            connection.query(`INSERT INTO item_data (id, normalized_name, base_price, width, height, wiki_link, properties)
                VALUES (
                    '${item._id}',
                    ${connection.escape(normalizeName(item._props.Name))},
                    ${item._props.CreditsPrice},
                    ${item._props.Width},
                    ${item._props.Height},
                    ${connection.escape(item.wikiLink)},
                    ${connection.escape(JSON.stringify(extraProperties))}
                )
                ON DUPLICATE KEY UPDATE
                    normalized_name=${connection.escape(normalizeName(item._props.Name))},
                    base_price=${item._props.CreditsPrice},
                    width=${item._props.Width},
                    height=${item._props.Height},
                    wiki_link=${connection.escape(item.wikiLink)},
                    properties=${connection.escape(JSON.stringify(extraProperties))}`
                , (error) => {
                    if (error) {
                        reject(error)
                    }

                    resolve();
                }
            );
        });

        try {
            await promise;
        } catch (upsertError){
            console.error(upsertError);

            throw upsertError;
        }
    }

    connection.end();
};