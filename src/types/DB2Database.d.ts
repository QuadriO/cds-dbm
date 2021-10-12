import { DatabaseService } from '@sap/cds/apis/services'

export interface DB2Database extends DatabaseService {
  cdssql2db2sql(query: string): string
}
