import DB2 from 'ibm_db'
import fs from 'fs'
import liquibase from '../liquibase'
import { BaseAdapter } from './BaseAdapter'
import { liquibaseOptions } from './../config'
import { DB2Database } from './../types/DB2Database'
import { ChangeLog } from '../ChangeLog'
import { ViewDefinition } from '../types/AdapterTypes'

const getCredentialsForClient = (credentials, bIncludeDbName) => {
  let connString = "";
  if (bIncludeDbName){
    connString = `${connString}DATABASE=${credentials.database};`
  }
  connString = `${connString}HOSTNAME=${credentials.host};PORT=${credentials.port};`
  if (credentials.sslrootcert) {
      connString = `${connString}Security=SSL;SSLServerCertificate=${credentials.sslrootcert};`
    } 
    connString = `${connString}PROTOCOL=TCPIP;UID=${credentials.user};PWD=${credentials.password}`
  return connString
}

export class DB2Adapter extends BaseAdapter {
  async getViewDefinition(viewName: string): Promise<ViewDefinition> {
    const credentials = this.options.service.credentials
    const connection = DB2.openSync(getCredentialsForClient(credentials, true))

    const { rows } = connection.querySync(
        `SELECT table_name, view_definition FROM information_schema.views WHERE table_schema = 'public' AND table_name = $1 ORDER BY table_name;`,
        [viewName]
    )
    
    connection.closeSync();

    const viewDefinition: ViewDefinition = {
      name: viewName,
      definition: rows[0]?.view_definition?.replace(/public./g, ''),
    }

    return viewDefinition
  }

  /**
   *
   * @override
   * @param table
   */
  async _truncateTable(table: any): Promise<void> {
    const credentials = this.options.service.credentials
    DB2.open(getCredentialsForClient(credentials, true), function(err, connection){
        connection.query(`TRUNCATE ${table} RESTART IDENTITY`)
    });

  }
  /**
   *
   */
  async _dropViewsFromCloneDatabase(): Promise<void> {
    const credentials = this.options.service.credentials
    const cloneSchema = this.options.migrations.schema!.clone
    const connection = DB2.openSync(getCredentialsForClient(credentials, true))

    await connection.querySync(`SET PATH TO ${cloneSchema};`)

    for (const query of this.cdsSQL) {
      const [, table, entity] = query.match(/^\s*CREATE (?:(TABLE)|VIEW)\s+"?([^\s(]+)"?/im) || []
      if (!table) {
        await connection.querySync(`DROP VIEW ${entity}`)
      }
    }

    return connection.closeSync()
  }

  /**
   * Returns the liquibase options for the given command.
   *
   * @override
   * @param {string} cmd
   */
  liquibaseOptionsFor(cmd: string): liquibaseOptions {
    const credentials = this.options.service.credentials
    var url = `jdbc:db2://${credentials.host || credentials.host}:${credentials.port}/${
      credentials.database || credentials.dbname
    }`
    if (credentials.sslrootcert) {
      url += '?ssl=true'
    }

    const liquibaseOptions: liquibaseOptions = {
      username: credentials.user || credentials.username,
      password: this.options.service.credentials.password,
      url: url,
      classpath: `${__dirname}/../../drivers/db2jcc.jar`,
      driver: 'com.ibm.db2.jcc.DB2Driver',
    }

    switch (cmd) {
      case 'diffChangeLog':
      case 'diff':
        liquibaseOptions.referenceUrl = liquibaseOptions.url
        liquibaseOptions.referenceUsername = liquibaseOptions.username
        liquibaseOptions.referencePassword = liquibaseOptions.password
        liquibaseOptions.defaultSchemaName = this.options.migrations.schema!.default
        liquibaseOptions.referenceDefaultSchemaName = this.options.migrations.schema!.reference
        break
      case 'update':
      case 'updateSQL':
      case 'dropAll':
      default:
        break
    }

    return liquibaseOptions
  }

  async _synchronizeCloneDatabase() {
    const credentials = this.options.service.credentials
    const cloneSchema = this.options.migrations.schema!.clone
    const temporaryChangelogFile = `${this.options.migrations.deploy.tmpFile}`

    const connection = DB2.openSync(getCredentialsForClient(credentials, true));
    await connection.querySync(`DROP SCHEMA ${cloneSchema} RESTRICT`)
    await connection.querySync(`CREATE SCHEMA ${cloneSchema}`)
    await connection.closeSync()

    // Basically create a copy of the schema
    let liquibaseOptions = this.liquibaseOptionsFor('diffChangeLog')
    liquibaseOptions.defaultSchemaName = cloneSchema
    liquibaseOptions.referenceDefaultSchemaName = this.options.migrations.schema!.default
    liquibaseOptions.changeLogFile = temporaryChangelogFile

    await liquibase(liquibaseOptions).run('diffChangeLog')

    // Remove unnecessary stuff
    const diffChangeLog = ChangeLog.fromFile(temporaryChangelogFile)
    diffChangeLog.toFile(temporaryChangelogFile)

    // Now deploy the copy to the clone
    liquibaseOptions = this.liquibaseOptionsFor('update')
    liquibaseOptions.defaultSchemaName = cloneSchema
    liquibaseOptions.changeLogFile = temporaryChangelogFile

    await liquibase(liquibaseOptions).run('update')

    fs.unlinkSync(temporaryChangelogFile)

    return Promise.resolve()
  }

  /**
   * @override
   */
  async _deployCdsToReferenceDatabase() {
    const credentials = this.options.service.credentials
    const referenceSchema = this.options.migrations.schema!.reference
    const connection = DB2.openSync(getCredentialsForClient(credentials, true))
    await connection.querySync(`DROP SCHEMA ${referenceSchema} RESTRICT`)
    await connection.querySync(`CREATE SCHEMA ${referenceSchema}`)
    await connection.querySync(`SET PATH TO ${referenceSchema};`)

    const serviceInstance = cds.services[this.serviceKey] as DB2Database
    for (const query of this.cdsSQL) {
      await connection.querySync(serviceInstance.cdssql2db2sql(query))
    }

    return connection.closeSync()
  }

  /**
   * @override
   */
  async _createDatabase() {
    // Do not connect directly to the database
    const clientCredentials = getCredentialsForClient(this.options.service.credentials, false)

    const connection = DB2.openSync(clientCredentials)

    try {
      // Revisit: should be more safe, but does not work
      // await client.query(`CREATE DATABASE $1`, [this.options.service.credentials.database])
      await connection.query(`CREATE DATABASE ${this.options.service.credentials.database}`)
      this.logger.log(`[cds-dbm] - created database ${this.options.service.credentials.database}`)
    } catch (error) {
      switch (error.code) {
        case '42P04': // already exists
          this.logger.log(`[cds-dbm] - database ${this.options.service.credentials.database} is already present`)
        case '23505': // concurrent attempt
          break
        default:
          throw error
      }
    }

    connection.closeSync()
  }
}
