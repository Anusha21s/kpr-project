$pgBin = "C:\Users\anuse\Downloads\kpr\pgsql\pgsql\bin"
$pgData = "C:\Users\anuse\Downloads\kpr\pgsql\data"
$pgLog = "C:\Users\anuse\Downloads\kpr\pgsql\pg.log"

& "$pgBin\pg_ctl.exe" -D "$pgData" -l "$pgLog" start
Start-Sleep -Seconds 3

& "$pgBin\psql.exe" -U postgres -c "CREATE ROLE medicore WITH LOGIN PASSWORD 'medicore_dev_pw' SUPERUSER CREATEDB;"
& "$pgBin\psql.exe" -U postgres -c "CREATE DATABASE medicore OWNER medicore;"
