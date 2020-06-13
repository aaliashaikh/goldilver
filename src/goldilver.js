'use strict';
const shim = require('fabric-shim');
const util = require('util');

/************************************************************************************************
 * 
 * GENERAL FUNCTIONS 
 * 
 ************************************************************************************************/

/**
 * Executes a query using a specific key
 * 
 * @param {*} key - the key to use in the query
 */
async function queryByKey(stub, key) {
  console.log('============= START : queryByKey ===========');
  console.log('##### queryByKey key: ' + key);

  let resultAsBytes = await stub.getState(key); 
  if (!resultAsBytes || resultAsBytes.toString().length <= 0) {
    throw new Error('##### queryByKey key: ' + key + ' does not exist');
  }
  console.log('##### queryByKey response: ' + resultAsBytes);
  console.log('============= END : queryByKey ===========');
  return resultAsBytes;
}

/**
 * Executes a query based on a provided queryString
 * 
 * I originally wrote this function to handle rich queries via CouchDB, but subsequently needed
 * to support LevelDB range queries where CouchDB was not available.
 * 
 * @param {*} queryString - the query string to execute
 */
async function queryByString(stub, queryString) {
  console.log('============= START : queryByString ===========');
  console.log("##### queryByString queryString: " + queryString);

  // CouchDB Query
  // let iterator = await stub.getQueryResult(queryString);

  // Equivalent LevelDB Query. We need to parse queryString to determine what is being queried
  // In this chaincode, all queries will either query ALL records for a specific docType, or
  // they will filter ALL the records looking for a specific NGO, Donor, Donation, etc. So far, 
  // in this chaincode there is a maximum of one filter parameter in addition to the docType.
  let docType = "";
  let startKey = "";
  let endKey = "";
  let jsonQueryString = JSON.parse(queryString);
  if (jsonQueryString['selector'] && jsonQueryString['selector']['docType']) {
    docType = jsonQueryString['selector']['docType'];
    startKey = docType + "0";
    endKey = docType + "z";
  }
  else {
    throw new Error('##### queryByString - Cannot call queryByString without a docType element: ' + queryString);   
  }

  let iterator = await stub.getStateByRange(startKey, endKey);

  // Iterator handling is identical for both CouchDB and LevelDB result sets, with the 
  // exception of the filter handling in the commented section below
  let allResults = [];
  while (true) {
    let res = await iterator.next();

    if (res.value && res.value.value.toString()) {
      let jsonRes = {};
      console.log('##### queryByString iterator: ' + res.value.value.toString('utf8'));

      jsonRes.Key = res.value.key;
      try {
        jsonRes.Record = JSON.parse(res.value.value.toString('utf8'));
      } 
      catch (err) {
        console.log('##### queryByString error: ' + err);
        jsonRes.Record = res.value.value.toString('utf8');
      }
      // ******************* LevelDB filter handling ******************************************
      // LevelDB: additional code required to filter out records we don't need
      // Check that each filter condition in jsonQueryString can be found in the iterator json
      // If we are using CouchDB, this isn't required as rich query supports selectors
      let jsonRecord = jsonQueryString['selector'];
      // If there is only a docType, no need to filter, just return all
      console.log('##### queryByString jsonRecord - number of JSON keys: ' + Object.keys(jsonRecord).length);
      if (Object.keys(jsonRecord).length == 1) {
        allResults.push(jsonRes);
        continue;
      }
      for (var key in jsonRecord) {
        if (jsonRecord.hasOwnProperty(key)) {
          console.log('##### queryByString jsonRecord key: ' + key + " value: " + jsonRecord[key]);
          if (key == "docType") {
            continue;
          }
          console.log('##### queryByString json iterator has key: ' + jsonRes.Record[key]);
          if (!(jsonRes.Record[key] && jsonRes.Record[key] == jsonRecord[key])) {
            // we do not want this record as it does not match the filter criteria
            continue;
          }
          allResults.push(jsonRes);
        }
      }
      // ******************* End LevelDB filter handling ******************************************
      // For CouchDB, push all results
      // allResults.push(jsonRes);
    }
    if (res.done) {
      await iterator.close();
      console.log('##### queryByString all results: ' + JSON.stringify(allResults));
      console.log('============= END : queryByString ===========');
      return Buffer.from(JSON.stringify(allResults));
    }
  }
}

/**
 * Record spend made by an NGO
 * 
 * This functions allocates the spend amongst the donors, so each donor can see how their 
 * donations are spent. The logic works as follows:
 * 
 *    - Get the donations made to this NGO
 *    - Get the spend per donation, to calculate how much of the donation amount is still available for spending
 *    - Calculate the total amount spent by this NGO
 *    - If there are sufficient donations available, create a SPEND record
 *    - Allocate the spend between all the donations and create SPENDALLOCATION records
 * 
 * @param {*} spend - the spend amount to be recorded. This will be JSON, as follows:
 * {
 *   "docType": "spend",
 *   "spendId": "1234",
 *   "spendAmount": 100,
 *   "spendDate": "2018-09-20T12:41:59.582Z",
 *   "spendDescription": "Joe Jeremy",
 *   "vendorRegistrationNumber": "1234"
 * }
 */
async function allocateSpend(stub, spend) {
  console.log('============= START : allocateSpend ===========');
  console.log('##### allocateSpend - Spend received: ' + JSON.stringify(spend));

  // validate we have a valid SPEND object and a valid amount
  if (!(spend && spend['spendAmount'] && typeof spend['spendAmount'] === 'number' && isFinite(spend['spendAmount']))) {
    throw new Error('##### allocateSpend - Spend Amount is not a valid number: ' + spend['spendAmount']);   
  }
  // validate we have a valid SPEND object and a valid SPEND ID
  if (!(spend && spend['spendId'])) {
    throw new Error('##### allocateSpend - Spend Id is required but does not exist in the spend message');   
  }

  // validate that we have a valid vendor
  let vendor = spend['vendorRegistrationNumber'];
  let vendorKey = 'vendor' + vendor;
  let vendorQuery = await queryByKey(stub, vendorKey);
  if (!vendorQuery.toString()) {
    throw new Error('##### allocateSpend - Cannot create spend allocation record as the vendor does not exist: ' + json['vendorRegistrationNumber']);
  }

  // first, get the total amount of transactions done with this vendor
  let totaltransactions = 0;
  const transactionMap = new Map();
  let queryString = '{"selector": {"docType": "transaction", "vendorRegistrationNumber": "' + vendor + '"}}';
  let transactionsWithVendor = await queryByString(stub, queryString);
  console.log('##### allocateSpend - allocateSpend - getTransactionsWithVendor: ' + transactionsWithVendor);
  transactionsWithVendor = JSON.parse(transactionsWithVendor.toString());
  console.log('##### allocateSpend - getTransactionsWithVendor as JSON: ' + transactionsWithVendor);

  // store all transactions with the gold vendors in a map. Each entry in the map will look as follows:
  //
  // {"Key":"transaction2211","Record":{"docType":"transaction","transactionAmount":100,"transactionDate":"2018-09-20T12:41:59.582Z","transactionId":"2211","gdUserName":"edge","vendorRegistrationNumber":"6322"}}
  for (let n = 0; n < transactionsWithVendor.length; n++) {
    let transaction = transactionsWithVendor[n];
    console.log('##### allocateSpend - getTransactionsWithVendor Transaction: ' + JSON.stringify(transaction));
    totaltransactions += transaction['Record']['transactionAmount'];
    // store the transactions made
    transactionMap.set(transaction['Record']['transactionId'], transaction);
    console.log('##### allocateSpend - transactionMap - adding new transaction entry for gduser: ' + transaction['Record']['transactionId'] + ', values: ' + JSON.stringify(transaction));
  }
  console.log('##### allocateSpend - Total transactions for this vendor are: ' + totalTransactions);
  for (let transaction of transactionMap) {
    console.log('##### allocateSpend - Total transaction for this transaction ID: ' + transaction[0] + ', amount: ' + transaction[1]['Record']['transactionAmount'] + ', entry: ' + JSON.stringify(transaction[1]));
  }

  // next, get the spend by Donation, i.e. the amount of each Donation that has already been spent -- not required for Goldilver
  let totalSpend = 0;
  const transactionSpendMap = new Map();
  queryString = '{"selector": {"docType": "spendAllocation", "vendorRegistrationNumber": "' + vendor + '"}}';
  let spendAllocations = await queryByString(stub, queryString);
  spendAllocations = JSON.parse(spendAllocations.toString());
  for (let n = 0; n < spendAllocations.length; n++) {
    let spendAllocation = spendAllocations[n]['Record'];
    totalSpend += spendAllocation['spendAllocationAmount'];
    // store the spend made per Transaction
    if (transactionSpendMap.has(spendAllocation['transactionId'])) {
      let spendAmt = transactionSpendMap.get(spendAllocation['transactionId']);
      spendAmt += spendAllocation['spendAllocationAmount'];
      transactionSpendMap.set(spendAllocation['transactionId'], spendAmt);
      console.log('##### allocateSpend - transactionSpendMap - updating transaction entry for transaction ID: ' + spendAllocation['transactionId'] + ' amount: ' + spendAllocation['spendAllocationAmount'] + ' total amt: ' + spendAmt);
    }
    else {
      transactionSpendMap.set(spendAllocation['transactionId'], spendAllocation['spendAllocationAmount']);
      console.log('##### allocateSpend - transactionSpendMap - adding new transaction entry for transaction ID: ' + spendAllocation['transactionId'] + ' amount: ' + spendAllocation['spendAllocationAmount']);
    }
  }
  console.log('##### allocateSpend - Total spend for this vendor is: ' + totalSpend);
  for (let transaction of transactionSpendMap) {
    console.log('##### allocateSpend - Total spend against this transaction ID: ' + transaction[0] + ', spend amount: ' + transaction[1] + ', entry: ' + transaction);  
    if (transactionMap.has(transaction[0])) {
      console.log('##### allocateSpend - The matching transaction for this transaction ID: ' + transaction[0] + ', transaction amount: ' + transactionMap.get(transaction[0]));  
    }
    else {
      console.log('##### allocateSpend - ERROR - cannot find the matching transaction for this spend record for transaction ID: ' + transaction[0]);  
    }
  }

  // at this point we have the total amount of transactions done by gdusers with each vendor. We also have the total spend
  // spent by a vendor with a breakdown per transaction. 

  // confirm whether the vendor has sufficient available funds to cover the new spend
  let totalAvailable = totalTransactions - totalSpend;
  if (spend['spendAmount'] > totalAvailable) {
    // Execution stops at this point; the transaction fails and rolls back.
    // Any updates made by the transaction processor function are discarded.
    // Transaction processor functions are atomic; all changes are committed,
    // or no changes are committed.
    console.log('##### allocateSpend - vendor ' + vendor + ' does not have sufficient funds available to cover this spend. Spend amount is: ' + spend['spendAmount'] + '. Available funds are currently: ' + totalAvailable + '. Total transactions are: ' + totalTransactions + ', total spend is: ' + totalSpend);
    throw new Error('vendor ' + vendor + ' does not have sufficient funds available to cover this spend. Spend amount is: ' + spend['spendAmount'] + '. Available funds are currently: ' + totalAvailable);
  }

  // since the vendor has sufficient funds available, add the new spend record
  spend['docType'] = 'spend';
  let key = 'spend' + spend['spendId'];
  console.log('##### allocateSpend - Adding the spend record to vendorSpend. Spend record is: ' + JSON.stringify(spend) + ' key is: ' + key);
  await stub.putState(key, Buffer.from(JSON.stringify(spend)));

  // allocate the spend as equally as possible to all the transactions
  console.log('##### allocateSpend - Allocating the spend amount amongst the transactions from gdusers who transacted funds with this vendor');
  let spendAmount = spend.spendAmount;
  let numberOfTransactions = 0;
  let spendAmountForgduser = 0;
  let recordCounter = 0;

  while (true) {
    // spendAmount will be reduced as the spend is allocated to vendorSpendTransactionAllocation records. 
    // Once it reaches 0 we stop allocating. This caters for cases where the full allocation cannot
    // be allocated to a transaction record. In this case, only the remaining transaction amount is allocated 
    // (see variable amountAllocatedToTransaction below).
    // The remaining amount must be allocated to transaction records with sufficient available funds.
    if (spendAmount <= 0) {
      break;
    }
    // calculate the number of transactions still available, i.e. transactions which still have funds available for spending. 
    // as the spending reduces the transactions there may be fewer and fewer transactions available to split the spending between
    // 
    // all transactions for the vendor are in transactionMap. Each entry in the map will look as follows:
    //
    // {"Key":"transaction2211","Record":{"docType":"transaction","transactionAmount":100,"transactionDate":"2018-09-20T12:41:59.582Z","transactionId":"2211","gdUserName":"edge","vendorRegistrationNumber":"6322"}}
    numberOftransactions = 0;
    for (let transaction of transactionMap) {
      console.log('##### allocateSpend - Transaction record, key is: ' +  transaction[0] + ' value is: ' + JSON.stringify(transaction[1]));
      if (transactionSpendMap.has(transaction[0])) {
        spendAmountForgduser = donationSpendMap.get(donation[0]);
      }
      else {
        spendAmountForgduser = 0;
      }
      let availableAmountForgduser = transaction[1]['Record']['transactionAmount'] - spendAmountForgduser;
      console.log('##### allocateSpend - Checking number of transactions available for allocation. Transaction ID: ' +  transaction[0] + ' has spent: ' + spendAmountForgduser + ' and has the following amount available for spending: ' + availableAmountForgduser);
      if (availableAmountForgduser > 0) {
        numberOftransactions++;
      }
    }
    //Validate that we have a valid spendAmount, numberOftransactions and spendAmountForgduser
    //Invalid values could be caused by a bug in this function, or invalid values passed to this function
    //that were not caught by the validation process earlier.
    if (!(spendAmount && typeof spendAmount === 'number' && isFinite(spendAmount))) {
      throw new Error('##### allocateSpend - spendAmount is not a valid number: ' + spendAmount);   
    }
    if (!(numberOftransactions && typeof numberOftransactions === 'number' && numberOftransactions > 0)) {
      throw new Error('##### allocateSpend - numberOftransactions is not a valid number or is < 1: ' + numberOftransactions);   
    }
    //calculate how much spend to allocate to each transaction
    let spendPertransaction = spendAmount / numberOftransactions;
    console.log('##### allocateSpend - Allocating the total spend amount of: ' + spendAmount + ', to ' + numberOftransactions + ' traansactions, resulting in ' + spendPertransaction + ' per transaction');

    if (!(spendPertransaction && typeof spendPertransaction === 'number' && isFinite(spendPertransaction))) {
      throw new Error('##### allocateSpend - spendPertransaction is not a valid number: ' + spendPertransaction);   
    }

    // create the SPENDALLOCATION records. Each record looks as follows:
    //
    // {
    //   "docType":"spendAllocation",
    //   "spendAllocationId":"c5b39e938a29a80c225d10e8327caaf817f76aecd381c868263c4f59a45daf62-1",
    //   "spendAllocationAmount":38.5,
    //   "spendAllocationDate":"2018-09-20T12:41:59.582Z",
    //   "spendAllocationDescription":"Joe Jeremy",
    //   "transactionId":"FFF6A68D-DB19-4CD3-97B0-01C1A793ED3B",
    //   "vendorRegistrationNumber":"D0884B20-385D-489E-A9FD-2B6DBE5FEA43",
    //   "spendId": "1234"
    // }

    for (let transaction of transactionMap) {
      let transactionId = transaction[0];
      let transactionInfo = transaction[1]['Record'];
      //calculate how much of the transaction's amount remains available for spending
      let transactionAmount = transactionInfo['transactionAmount'];
      if (transactionSpendMap.has(transactionId)) {
        spendAmountForgduser = transactionSpendMap.get(transactionId);
      }
      else {
        spendAmountForgduser = 0;
      }
      let availableAmountForgduser = transactionAmount - spendAmountForgduser;
      //if the transaction does not have sufficient funds to cover their allocation, then allocate
      //all of the outstanding transaction funds
      let amountAllocatedTotransaction = 0;
      if (availableAmountForgduser >= spendPertransaction) {
        amountAllocatedTotransaction = spendPertransaction;
        console.log('##### allocateSpend - transaction ID ' + transactionId + ' has sufficient funds to cover full allocation. Allocating: ' + amountAllocatedTotransaction);
      }
      else if (availableAmountForgduser > 0) {
        amountAllocatedTotransaction = availableAmountForgduser;
        // reduce the number of transactions available since this transaction record is fully allocated
        numberOftransactions -= 1;
        console.log('##### allocateSpend - transaction ID ' + transactionId + ' does not have sufficient funds to cover full allocation. Using all available funds: ' + amountAllocatedTotransaction);
      }
      else {
        // reduce the number of transactions available since this transaction record is fully allocated
        numberOftransactions -= 1;
        console.log('##### allocateSpend - transaction ID ' + transactionId + ' has no funds available at all. Available amount: ' + availableAmountForgduser + '. This transaction ID will be ignored');
        continue;
      }
      // add a new spendAllocation record containing the portion of a transaction allocated to this spend
      //
      // spendAllocationId is (hopefully) using an ID created in a deterministic manner, meaning it should
      // be identical on all endorsing peer nodes. If it isn't, the transaction validation process will fail
      // when Fabric compares the write-sets for each transaction and discovers there is are different values.
      let spendAllocationId = stub.getTxID() + '-' + recordCounter;
      recordCounter++;
      let key = 'spendAllocation' + spendAllocationId;
      let spendAllocationRecord = {
        docType: 'spendAllocation',
        spendAllocationId: spendAllocationId,
        spendAllocationAmount: amountAllocatedTotransaction,
        spendAllocationDate: spend['spendDate'],
        spendAllocationDescription: spend['spendDescription'],
        transactionId: transactionId,
        vendorRegistrationNumber: vendor,
        spendId: spend['spendId']
      }; 

      console.log('##### allocateSpend - creating spendAllocationRecord record: ' + JSON.stringify(spendAllocationRecord));
      await stub.putState(key, Buffer.from(JSON.stringify(spendAllocationRecord)));

      //reduce the total spend amount by the amount just spent in the vendorSpendtransactionAllocation record
      spendAmount -= amountAllocatedTotransaction;

      //update the spending map entry for this vendor. There may be no existing spend, in which case we'll create an entry in the map
      if (transactionSpendMap.has(transactionId)) {
        let spendAmt = transactionSpendMap.get(transactionId);
        spendAmt += amountAllocatedTotransaction;
        transactionSpendMap.set(transactionId, spendAmt);
        console.log('##### allocateSpend - transactionSpendMap - updating spend entry for transaction Id: ' + transactionId + ' with spent amount allocated to transaction: ' + amountAllocatedTotransaction + ' - total amount of this transaction now spent is: ' + spendAmt);
      }
      else {
        transactionSpendMap.set(transactionId, amountAllocatedTotransaction);
        console.log('##### allocateSpend - transactionSpendMap - adding new spend entry for transaction ID: ' + transactionId + ' with spent amount allocated to transaction: ' + amountAllocatedTotransaction);
      }
    }
  }
  console.log('============= END : allocateSpend ===========');
}  

/************************************************************************************************
 * 
 * CHAINCODE
 * 
 ************************************************************************************************/

let Chaincode = class {

  /**
   * Initialize the state when the chaincode is either instantiated or upgraded
   * 
   * @param {*} stub 
   */
  async Init(stub) {
    console.log('=========== Init: Instantiated / Upgraded goldilver chaincode ===========');
    return shim.success();
  }

  /**
   * The Invoke method will call the methods below based on the method name passed by the calling
   * program.
   * 
   * @param {*} stub 
   */
  async Invoke(stub) {
    console.log('============= START : Invoke ===========');
    let ret = stub.getFunctionAndParameters();
    console.log('##### Invoke args: ' + JSON.stringify(ret));

    let method = this[ret.fcn];
    if (!method) {
      console.error('##### Invoke - error: no chaincode function with name: ' + ret.fcn + ' found');
      throw new Error('No chaincode function with name: ' + ret.fcn + ' found');
    }
    try {
      let response = await method(stub, ret.params);
      console.log('##### Invoke response payload: ' + response);
      return shim.success(response);
    } catch (err) {
      console.log('##### Invoke - error: ' + err);
      return shim.error(err);
    }
  }

  /**
   * Initialize the state. This should be explicitly called if required.
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async initLedger(stub, args) {
    console.log('============= START : Initialize Ledger ===========');
    console.log('============= END : Initialize Ledger ===========');
  }

  /************************************************************************************************
   * 
   * User functions 
   * 
   ************************************************************************************************/

   /**
   * Creates a new user
   * 
   * @param {*} stub 
   * @param {*} args - JSON as follows:
   * {
   *    "gdUserName":"edge",
   *    "email":"edge@abc.com",
   *    "registeredDate":"2018-10-22T11:52:20.182Z"
   * }
   */
  async creategduser(stub, args) {
    console.log('============= START : creategduser ===========');
    console.log('##### creategduser arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'gduser' + json['gdUserName'];
    json['docType'] = 'gduser';

    console.log('##### creategduser payload: ' + JSON.stringify(json));

    // Check if the gduser already exists
    let gduserQuery = await stub.getState(key);
    if (gduserQuery.toString()) {
      throw new Error('##### creategduser - This user already exists: ' + json['gdUserName']);
    }

    await stub.putState(key, Buffer.from(JSON.stringify(json)));
    console.log('============= END : creategduser ===========');
  }

  /**
   * Retrieves a specfic user
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async querygduser(stub, args) {
    console.log('============= START : querygduser ===========');
    console.log('##### querygduser arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'gduser' + json['gdUserName'];
    console.log('##### querygdUser key: ' + key);

    return queryByKey(stub, key);
  }

  /**
   * Retrieves all users
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async queryAllgdusers(stub, args) {
    console.log('============= START : queryAllgdusers ===========');
    console.log('##### queryAllgdusers arguments: ' + JSON.stringify(args));
 
    let queryString = '{"selector": {"docType": "gduser"}}';
    return queryByString(stub, queryString);
  }

  /************************************************************************************************
   * 
   * Vendor functions 
   * 
   ************************************************************************************************/

  /**
   * Creates a new Vendor
   * 
   * @param {*} stub 
   * @param {*} args - JSON as follows:
   * {
   *    "vendorRegistrationNumber":"6322",
   *    "vendorName":"Tanishq",
   *    "vendorDescription":"Pure Jewellery Pure Joy",
   *    "address":"1 Cama street",
   *    "contactNumber":"82372837",
   *    "contactEmail":"info@tanishq.com"
   * }
   */
  async createvendor(stub, args) {
    console.log('============= START : createvendor ===========');
    console.log('##### createvendor arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'vendor' + json['vendorRegistrationNumber'];
    json['docType'] = 'vendor';

    console.log('##### createvendor payload: ' + JSON.stringify(json));

    // Check if the vendor already exists
    let vendorQuery = await stub.getState(key);
    if (vendorQuery.toString()) {
      throw new Error('##### createvendor - This vendor already exists: ' + json['vendorRegistrationNumber']);
    }

    await stub.putState(key, Buffer.from(JSON.stringify(json)));
    console.log('============= END : createvendor ===========');
  }

  /**
   * Retrieves a specfic vendor
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async queryvendor(stub, args) {
    console.log('============= START : queryvendor ===========');
    console.log('##### queryvendor arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'vendor' + json['vendorRegistrationNumber'];
    console.log('##### queryvendor key: ' + key);

    return queryByKey(stub, key);
  }

  /**
   * Retrieves all vendors
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async queryAllvendors(stub, args) {
    console.log('============= START : queryAllvendors ===========');
    console.log('##### queryAllvendors arguments: ' + JSON.stringify(args));
 
    let queryString = '{"selector": {"docType": "vendor"}}';
    return queryByString(stub, queryString);
  }

  /************************************************************************************************
   * 
   * Transaction functions 
   * 
   ************************************************************************************************/

  /**
   * Creates a new Transaction
   * 
   * @param {*} stub 
   * @param {*} args - JSON as follows:
   * {
   *    "transactionId":"2211",
   *    "transactionAmount":100,
   *    "transactionDate":"2018-09-20T12:41:59.582Z",
   *    "gdUserName":"edge",
   *    "vendorRegistrationNumber":"6322"
   * }
   */
  async createTransactionwithvendor(stub, args) {
    console.log('============= START : createTransaction ===========');
    console.log('##### createTransaction arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'transaction' + json['transactionId'];
    json['docType'] = 'transaction';

    console.log('##### createTransaction transaction: ' + JSON.stringify(json));

    // Confirm the vendor exists
    let vendorKey = 'vendor' + json['vendorRegistrationNumber'];
    let vendorQuery = await stub.getState(vendorKey);
    if (!vendorQuery.toString()) {
      throw new Error('##### createTransaction - Cannot create transaction as the vendor does not exist: ' + json['vendorRegistrationNumber']);
    }

    // Confirm the gduser exists
    let gduserKey = 'gduser' + json['gdUserName'];
    let gduserQuery = await stub.getState(gduserKey);
    if (!gduserQuery.toString()) {
      throw new Error('##### createtransaction - Cannot create transaction as the user does not exist: ' + json['gdUserName']);
    }

    // Check if the transaction already exists
    let transactionQuery = await stub.getState(key);
    if (transactionQuery.toString()) {
      throw new Error('##### createtransaction - This transaction already exists: ' + json['transactionId']);
    }

    await stub.putState(key, Buffer.from(JSON.stringify(json)));
    console.log('============= END : createtransaction ===========');
  }
  
  /**
   * Creates a new Transaction with another gduser
   * 
   * @param {*} stub 
   * @param {*} args - JSON as follows:
   * {
   *    "transactionId":"2211",
   *    "transactionAmount":100,
   *    "transactionDate":"2018-09-20T12:41:59.582Z",
   *    "gdUserName":"edge",
   *    "gdUserName":"tom"
   * }
   */
   
   
  async createTransactionwithgduser(stub, args) {
	  
	  let gdUserNameSender = args[3];
	  let gdUserNameReceiver = args[4];
	  
    console.log('============= START : createTransaction ===========');
    console.log('##### createTransaction arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'transaction' + json['transactionId'];
    json['docType'] = 'transaction';

    console.log('##### createTransaction transaction: ' + JSON.stringify(json));

    // Confirm gduserSender exists
    let gduserKey = 'gduser' + gdUserNameSender;
    let gduserQuery = await stub.getState(gduserKey);
    if (!gduserQuery.toString()) {
      throw new Error('##### createtransaction - Cannot create transaction as the user does not exist: ' + gdUserNameSender);
    }

    // Confirm gduserReciever exists
    let gduserKey = 'gduser' + gdUserNameReceiver;
    let gduserQuery = await stub.getState(gduserKey);
    if (!gduserQuery.toString()) {
      throw new Error('##### createtransaction - Cannot create transaction as the user does not exist: ' + gdUserNameReceiver);
    }

    // Check if the transaction already exists
    let transactionQuery = await stub.getState(key);
    if (transactionQuery.toString()) {
      throw new Error('##### createtransaction - This transaction already exists: ' + json['transactionId']);
    }

    await stub.putState(key, Buffer.from(JSON.stringify(json)));
    console.log('============= END : createtransaction ===========');
  }

  /**
   * Retrieves a specfic transaction
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async querytransaction(stub, args) {
    console.log('============= START : querytransaction ===========');
    console.log('##### querytransaction arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'transaction' + json['transactionId'];
    console.log('##### querytransaction key: ' + key);
    return queryByKey(stub, key);
  }

  /**
   * Retrieves transactions for a specfic gduser
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async querytransactionsForgduser(stub, args) {
    console.log('============= START : querytransactionsForgduser ===========');
    console.log('##### querytransactionsForgduser arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let queryString = '{"selector": {"docType": "transaction", "gdUserName": "' + json['gdUserName'] + '"}}';
    return queryByString(stub, queryString);
  }

  /**
   * Retrieves transactions for a specfic vendor
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async querytransactionswithvendor(stub, args) {
    console.log('============= START : querytransactionswithvendor ===========');
    console.log('##### querytransactionswithvendor arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let queryString = '{"selector": {"docType": "transaction", "vendorRegistrationNumber": "' + json['vendorRegistrationNumber'] + '"}}';
    return queryByString(stub, queryString);
  }

  /**
   * Retrieves all transactions
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async queryAlltransactions(stub, args) {
    console.log('============= START : queryAlltransactions ===========');
    console.log('##### queryAlltransactions arguments: ' + JSON.stringify(args)); 
    let queryString = '{"selector": {"docType": "transaction"}}';
    return queryByString(stub, queryString);
  }

  /************************************************************************************************
   * 
   * Spend functions 
   * 
   ************************************************************************************************/

  /**
   * Creates a new Spend
   * 
   * @param {*} stub 
   * @param {*} args - JSON as follows:
   * {
   *    "vendorRegistrationNumber":"6322",
   *    "spendId":"2",
   *    "spendDescription":"Joe Jeremy",
   *    "spendDate":"2018-09-20T12:41:59.582Z",
   *    "spendAmount":33,
   * }
   */
  async createSpend(stub, args) {
    console.log('============= START : createSpend ===========');
    console.log('##### createSpend arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'spend' + json['spendId'];
    json['docType'] = 'spend';

    console.log('##### createSpend spend: ' + JSON.stringify(json));

    // Confirm the vendor exists
    let vendorKey = 'vendor' + json['vendorRegistrationNumber'];
    let vendorQuery = await stub.getState(vendorKey);
    if (!vendorQuery.toString()) {
      throw new Error('##### createtransaction - Cannot create spend record as the vendor does not exist: ' + json['vendorRegistrationNumber']);
    }

    // Check if the Spend already exists
    let spendQuery = await stub.getState(key);
    if (spendQuery.toString()) {
      throw new Error('##### createSpend - This Spend already exists: ' + json['spendId']);
    }

    await allocateSpend(stub, json);

    await stub.putState(key, Buffer.from(JSON.stringify(json)));
    console.log('============= END : createSpend ===========');
  }

  /**
   * Retrieves a specfic spend
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async querySpend(stub, args) {
    console.log('============= START : querySpend ===========');
    console.log('##### querySpend arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'spend' + json['spendId'];
    console.log('##### querySpend key: ' + key);
    return queryByKey(stub, key);
  }

  /**
   * Retrieves spend for a specfic vendor
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async querySpendForvendor(stub, args) {
    console.log('============= START : querySpendForvendor ===========');
    console.log('##### querySpendForvendor arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let queryString = '{"selector": {"docType": "spend", "vendorRegistrationNumber": "' + json['vendorRegistrationNumber'] + '"}}';
    return queryByString(stub, queryString);
  }

  /**
   * Retrieves all spend
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async queryAllSpend(stub, args) {
    console.log('============= START : queryAllSpends ===========');
    console.log('##### queryAllSpends arguments: ' + JSON.stringify(args)); 
    let queryString = '{"selector": {"docType": "spend"}}';
    return queryByString(stub, queryString);
  }

  /************************************************************************************************
   * 
   * SpendAllocation functions 
   * 
   ************************************************************************************************/

  /**
   * There is no CREATE SpendAllocation - the allocations are created in the function: allocateSpend
   * 
   * SPENDALLOCATION records look as follows:
   *
   * {
   *   "docType":"spendAllocation",
   *   "spendAllocationId":"c5b39e938a29a80c225d10e8327caaf817f76aecd381c868263c4f59a45daf62-1",
   *   "spendAllocationAmount":38.5,
   *   "spendAllocationDate":"2018-09-20T12:41:59.582Z",
   *   "spendAllocationDescription":"Joe Jeremy",
   *   "transactionId":"FFF6A68D-DB19-4CD3-97B0-01C1A793ED3B",
   *   "vendorRegistrationNumber":"D0884B20-385D-489E-A9FD-2B6DBE5FEA43",
   *   "spendId": "1234"
   * }
   */

  /**
   * Retrieves a specfic spendAllocation
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async querySpendAllocation(stub, args) {
    console.log('============= START : querySpendAllocation ===========');
    console.log('##### querySpendAllocation arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'spendAllocation' + json['spendAllocationId'];
    console.log('##### querySpendAllocation key: ' + key);
    return queryByKey(stub, key);
  }

  /**
   * Retrieves the spendAllocation records for a specific transaction
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async querySpendAllocationFortransaction(stub, args) {
    console.log('============= START : querySpendAllocationFortransaction ===========');
    console.log('##### querySpendAllocationFortransaction arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let queryString = '{"selector": {"docType": "spendAllocation", "transactionId": "' + json['transactionId'] + '"}}';
    return queryByString(stub, queryString);
  }

  /**
   * Retrieves the spendAllocation records for a specific Spend record
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async querySpendAllocationForSpend(stub, args) {
    console.log('============= START : querySpendAllocationForSpend ===========');
    console.log('##### querySpendAllocationForSpend arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let queryString = '{"selector": {"docType": "spendAllocation", "spendId": "' + json['spendId'] + '"}}';
    return queryByString(stub, queryString);
  }

  /**
   * Retrieves all spendAllocations
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async queryAllSpendAllocations(stub, args) {
    console.log('============= START : queryAllSpendAllocations ===========');
    console.log('##### queryAllSpendAllocations arguments: ' + JSON.stringify(args)); 
    let queryString = '{"selector": {"docType": "spendAllocation"}}';
    return queryByString(stub, queryString);
  }

  /************************************************************************************************
   * 
   * Ratings functions 
   * 
   ************************************************************************************************/

  /**
   * Creates a new Rating
   * 
   * @param {*} stub 
   * @param {*} args - JSON as follows:
   * {
   *    "vendorRegistrationNumber":"6322",
   *    "gdUserName":"edge",
   *    "rating":1,
   * }
   */
  async createRating(stub, args) {
    console.log('============= START : createRating ===========');
    console.log('##### createRating arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'rating' + json['vendorRegistrationNumber'] + json['gdUserName'];
    json['docType'] = 'rating';

    console.log('##### createRating payload: ' + JSON.stringify(json));

    // Check if the Rating already exists
    let ratingQuery = await stub.getState(key);
    if (ratingQuery.toString()) {
      throw new Error('##### createRating - Rating by userr: ' +  json['gdUserName'] + ' for vendor: ' + json['vendorRegistrationNumber'] + ' already exists');
    }

    await stub.putState(key, Buffer.from(JSON.stringify(json)));
    console.log('============= END : createRating ===========');
  }

  /**
   * Retrieves ratings for a specfic vendor
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async queryRatingsForvendor(stub, args) {
    console.log('============= START : queryRatingsForvendor ===========');
    console.log('##### queryRatingsForvendor arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let queryString = '{"selector": {"docType": "rating", "vendorRegistrationNumber": "' + json['vendorRegistrationNumber'] + '"}}';
    return queryByString(stub, queryString);
  }

  /**
   * Retrieves ratings for an vendor made by a specific user
   * 
   * @param {*} stub 
   * @param {*} args 
   */
  async querygduserRatingsForvendor(stub, args) {
    console.log('============= START : querygduserRatingsForvendor ===========');
    console.log('##### querygduserRatingsForvendor arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = 'rating' + json['vendorRegistrationNumber'] + json['gdUserName'];
    console.log('##### querygduserRatingsForvendor key: ' + key);
    return queryByKey(stub, key);
  }

  /************************************************************************************************
   * 
   * Blockchain related functions 
   * 
   ************************************************************************************************/

  /**
   * Retrieves the Fabric block and transaction details for a key or an array of keys
   * 
   * @param {*} stub 
   * @param {*} args - JSON as follows:
   * [
   *    {"key": "a207aa1e124cc7cb350e9261018a9bd05fb4e0f7dcac5839bdcd0266af7e531d-1"}
   * ]
   * 
   */
  async queryHistoryForKey(stub, args) {
    console.log('============= START : queryHistoryForKey ===========');
    console.log('##### queryHistoryForKey arguments: ' + JSON.stringify(args));

    // args is passed as a JSON string
    let json = JSON.parse(args);
    let key = json['key'];
    let docType = json['docType']
    console.log('##### queryHistoryForKey key: ' + key);
    let historyIterator = await stub.getHistoryForKey(docType + key);
    console.log('##### queryHistoryForKey historyIterator: ' + util.inspect(historyIterator));
    let history = [];
    while (true) {
      let historyRecord = await historyIterator.next();
      console.log('##### queryHistoryForKey historyRecord: ' + util.inspect(historyRecord));
      if (historyRecord.value && historyRecord.value.value.toString()) {
        let jsonRes = {};
        console.log('##### queryHistoryForKey historyRecord.value.value: ' + historyRecord.value.value.toString('utf8'));
        jsonRes.TxId = historyRecord.value.tx_id;
        jsonRes.Timestamp = historyRecord.value.timestamp;
        jsonRes.IsDelete = historyRecord.value.is_delete.toString();
      try {
          jsonRes.Record = JSON.parse(historyRecord.value.value.toString('utf8'));
        } catch (err) {
          console.log('##### queryHistoryForKey error: ' + err);
          jsonRes.Record = historyRecord.value.value.toString('utf8');
        }
        console.log('##### queryHistoryForKey json: ' + util.inspect(jsonRes));
        history.push(jsonRes);
      }
      if (historyRecord.done) {
        await historyIterator.close();
        console.log('##### queryHistoryForKey all results: ' + JSON.stringify(history));
        console.log('============= END : queryHistoryForKey ===========');
        return Buffer.from(JSON.stringify(history));
      }
    }
  }
}
shim.start(new Chaincode());