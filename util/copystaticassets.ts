import * as shell from 'shelljs'

shell.cp('-R', 'src/build/postgres-cf/template', 'dist/build/postgres-cf/template')
shell.cp('-R', 'src/build/db2-cf/template', 'dist/build/db2-cf/template')
