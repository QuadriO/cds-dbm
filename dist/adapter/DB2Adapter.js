"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DB2Adapter = void 0;
const ibm_db_1 = __importDefault(require("ibm_db"));
const fs_1 = __importDefault(require("fs"));
const liquibase_1 = __importDefault(require("../liquibase"));
const BaseAdapter_1 = require("./BaseAdapter");
const ChangeLog_1 = require("../ChangeLog");
const getCredentialsForClient = (credentials, bIncludeDbName) => {
    let connString = "";
    if (bIncludeDbName) {
        connString = `${connString}DATABASE=${credentials.database};`;
    }
    connString = `${connString}HOSTNAME=${credentials.host};PORT=${credentials.port};`;
    if (credentials.sslrootcert) {
        connString = `${connString}Security=SSL;SSLServerCertificate=${credentials.sslrootcert};`;
    }
    connString = `${connString}PROTOCOL=TCPIP;UID=${credentials.user};PWD=${credentials.password}`;
    return connString;
};
class DB2Adapter extends BaseAdapter_1.BaseAdapter {
    async getViewDefinition(viewName) {
        var _a, _b;
        const credentials = this.options.service.credentials;
        const connection = ibm_db_1.default.openSync(getCredentialsForClient(credentials, true));
        const rows = connection.querySync(`SELECT viewname, text FROM SYSCAT.views WHERE viewschema = '${this.options.migrations.schema.default}' AND viewname = '${viewName}';`);
        connection.closeSync();
        const viewDefinition = {
            name: viewName,
            definition: (_b = (_a = rows[0]) === null || _a === void 0 ? void 0 : _a.text) === null || _b === void 0 ? void 0 : _b.replace(/public./g, ''),
        };
        return viewDefinition;
    }
    /**
     *
     * @override
     * @param table
     */
    async _truncateTable(table) {
        const credentials = this.options.service.credentials;
        ibm_db_1.default.open(getCredentialsForClient(credentials, true), function (err, connection) {
            connection.query(`TRUNCATE ${table} RESTART IDENTITY`);
        });
    }
    /**
     *
     */
    async _dropViewsFromCloneDatabase() {
        const credentials = this.options.service.credentials;
        const cloneSchema = this.options.migrations.schema.clone;
        const connection = ibm_db_1.default.openSync(getCredentialsForClient(credentials, true));
        await connection.querySync(`SET CURRENT SCHEMA ${cloneSchema};`);
        for (const query of this.cdsSQL) {
            const [, table, entity] = query.match(/^\s*CREATE (?:(TABLE)|VIEW)\s+"?([^\s(]+)"?/im) || [];
            if (!table) {
                await connection.querySync(`DROP VIEW ${entity}`);
            }
        }
        return connection.closeSync();
    }
    /**
     * Returns the liquibase options for the given command.
     *
     * @override
     * @param {string} cmd
     */
    liquibaseOptionsFor(cmd) {
        const credentials = this.options.service.credentials;
        var url = `jdbc:db2://${credentials.host || credentials.host}:${credentials.port}/${credentials.database || credentials.dbname}`;
        if (credentials.sslrootcert) {
            url += '?ssl=true';
        }
        const liquibaseOptions = {
            username: credentials.user || credentials.username,
            password: this.options.service.credentials.password,
            url: url,
            classpath: `${__dirname}/../../drivers/db2jcc4.jar`,
            driver: 'com.ibm.db2.jcc.DB2Driver',
        };
        switch (cmd) {
            case 'diffChangeLog':
            case 'diff':
                liquibaseOptions.referenceUrl = liquibaseOptions.url;
                liquibaseOptions.referenceUsername = liquibaseOptions.username;
                liquibaseOptions.referencePassword = liquibaseOptions.password;
                liquibaseOptions.defaultSchemaName = this.options.migrations.schema.default;
                liquibaseOptions.referenceDefaultSchemaName = this.options.migrations.schema.reference;
                break;
            case 'update':
                break;
            case 'updateSQL':
                break;
            case 'dropAll':
            default:
                break;
        }
        return liquibaseOptions;
    }
    async _synchronizeCloneDatabase() {
        const credentials = this.options.service.credentials;
        const cloneSchema = this.options.migrations.schema.clone;
        const temporaryChangelogFile = `${this.options.migrations.deploy.tmpFile}`;
        const connection = ibm_db_1.default.openSync(getCredentialsForClient(credentials, true));
        const tables = await connection.querySync(`SELECT * FROM syscat.tables WHERE TABSCHEMA LIKE '${cloneSchema}'`);
        tables.forEach(async function (table) {
            if (table.TYPE === 'T') {
                await connection.querySync(`DROP TABLE ${cloneSchema}.${table.TABNAME}`);
            }
            else if (table.TYPE === 'V') {
                await connection.querySync(`DROP VIEW ${cloneSchema}.${table.TABNAME}`);
            }
        });
        await connection.querySync(`DROP SCHEMA ${cloneSchema} RESTRICT`);
        await connection.querySync(`CREATE SCHEMA ${cloneSchema}`);
        await connection.closeSync();
        // Basically create a copy of the schema
        let liquibaseOptions = this.liquibaseOptionsFor('diffChangeLog');
        liquibaseOptions.defaultSchemaName = cloneSchema;
        liquibaseOptions.referenceDefaultSchemaName = this.options.migrations.schema.default;
        liquibaseOptions.changeLogFile = temporaryChangelogFile;
        await (0, liquibase_1.default)(liquibaseOptions).run('diffChangeLog');
        // Remove unnecessary stuff
        const diffChangeLog = ChangeLog_1.ChangeLog.fromFile(temporaryChangelogFile);
        diffChangeLog.toFile(temporaryChangelogFile);
        // Now deploy the copy to the clone
        liquibaseOptions = this.liquibaseOptionsFor('update');
        liquibaseOptions.defaultSchemaName = cloneSchema;
        liquibaseOptions.referenceDefaultSchemaName = this.options.migrations.schema.default;
        liquibaseOptions.changeLogFile = temporaryChangelogFile;
        await (0, liquibase_1.default)(liquibaseOptions).run('update');
        fs_1.default.unlinkSync(temporaryChangelogFile);
        return Promise.resolve();
    }
    /**
     * @override
     */
    async _deployCdsToReferenceDatabase() {
        const credentials = this.options.service.credentials;
        const referenceSchema = this.options.migrations.schema.reference;
        const connection = ibm_db_1.default.openSync(getCredentialsForClient(credentials, true));
        const tables = await connection.querySync(`SELECT * FROM syscat.tables WHERE TABSCHEMA LIKE '${referenceSchema}'`);
        tables.forEach(async function (table) {
            if (table.TYPE === 'T') {
                await connection.querySync(`DROP TABLE ${referenceSchema}.${table.TABNAME}`);
            }
            else if (table.TYPE === 'V') {
                await connection.querySync(`DROP VIEW ${referenceSchema}.${table.TABNAME}`);
            }
        });
        await connection.querySync(`DROP SCHEMA ${referenceSchema} RESTRICT`);
        await connection.querySync(`CREATE SCHEMA ${referenceSchema}`);
        await connection.querySync(`SET CURRENT SCHEMA ${referenceSchema};`);
        const serviceInstance = cds.services[this.serviceKey];
        for (const query of this.cdsSQL) {
            await connection.querySync(serviceInstance.cdssql2db2sql(query));
        }
        return connection.closeSync();
    }
    /**
     * @override
     */
    async _createDatabase() {
        // Do not connect directly to the database
        const clientCredentials = getCredentialsForClient(this.options.service.credentials, false);
        const connection = ibm_db_1.default.openSync(clientCredentials);
        try {
            // Revisit: should be more safe, but does not work
            // await client.query(`CREATE DATABASE $1`, [this.options.service.credentials.database])
            await connection.query(`CREATE DATABASE ${this.options.service.credentials.database}`);
            this.logger.log(`[cds-dbm] - created database ${this.options.service.credentials.database}`);
        }
        catch (error) {
            switch (error.code) {
                case '42P04': // already exists
                    this.logger.log(`[cds-dbm] - database ${this.options.service.credentials.database} is already present`);
                case '23505': // concurrent attempt
                    break;
                default:
                    throw error;
            }
        }
        connection.closeSync();
    }
}
exports.DB2Adapter = DB2Adapter;
//# sourceMappingURL=DB2Adapter.js.map