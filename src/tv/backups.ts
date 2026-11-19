import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { AppStore, tables } from './store.js';
import { Vault } from './vault.js';
import { AppError } from './errors.js';
const blobColumns=new Set(['nonce','ciphertext','tag']);
export class Backups {
  constructor(readonly store:AppStore,readonly vault:Vault){}
  export(passphrase:unknown){if(typeof passphrase!=='string'||passphrase.length<20||passphrase.length>1024)throw new AppError('BACKUP_PASSPHRASE','Use a recovery passphrase of at least 20 characters');
    const data=this.store.db.transaction(()=>Object.fromEntries(tables.filter(t=>t!=='sessions').map(table=>[table,this.store.all(`SELECT * FROM ${table}`).map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,blobColumns.has(key)?Buffer.from(value as any).toString('base64'):value])))])))();
    const salt=randomBytes(16),nonce=randomBytes(12),key=scryptSync(passphrase,salt,32),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(Buffer.from('StreamBot-TV-backup-v1'));
    const body=Buffer.from(JSON.stringify({version:1,tables:data,keys:this.vault.exportKeys()}));if(body.length>20*1024*1024)throw new AppError('BACKUP_TOO_LARGE','Backup exceeds 20 MiB cap');
    return {format:'streambot-tv-v1',salt:salt.toString('base64'),nonce:nonce.toString('base64'),ciphertext:Buffer.concat([cipher.update(body),cipher.final()]).toString('base64'),tag:cipher.getAuthTag().toString('base64')};
  }
  import(envelope:any,passphrase:unknown,confirmed:boolean){if(!confirmed)throw new AppError('CONFIRM_REQUIRED','Confirm replacement of users, sessions, settings and credentials from this encrypted backup');
    if(typeof passphrase!=='string'||passphrase.length>1024||!envelope||envelope.format!=='streambot-tv-v1'||typeof envelope.ciphertext!=='string'||envelope.ciphertext.length>30*1024*1024)throw new AppError('INVALID_BACKUP','Invalid encrypted backup');
    let data:any;
    try{const salt=Buffer.from(envelope.salt,'base64'),nonce=Buffer.from(envelope.nonce,'base64'),tag=Buffer.from(envelope.tag,'base64');if(salt.length!==16||nonce.length!==12||tag.length!==16)throw Error();const cipher=createDecipheriv('aes-256-gcm',scryptSync(passphrase,salt,32),nonce);cipher.setAAD(Buffer.from('StreamBot-TV-backup-v1'));cipher.setAuthTag(tag);data=JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext,'base64')),cipher.final()]).toString());if(data.version!==1||!data.tables?.users?.some((u:any)=>u.role==='owner'))throw Error();}catch{throw new AppError('BACKUP_DECRYPT','Backup passphrase/integrity check failed');}
    this.vault.validate(data.keys);
    const previous=this.vault.exportKeys();
    // Retain both key sets before the database transaction. A crash at either
    // point can still decrypt the old or new DB; no silent key regeneration.
    this.vault.restoreKeys({active:previous.active,keys:{...previous.keys,...data.keys?.keys}});
    try{this.store.db.transaction(()=>{
      this.store.db.exec('PRAGMA defer_foreign_keys=ON');
      for(const table of [...tables].reverse())this.store.run(`DELETE FROM ${table}`);
      for(const table of tables){if(table==='sessions')continue;const rows=data.tables[table];if(!Array.isArray(rows)||rows.length>50000)throw new AppError('INVALID_BACKUP','Invalid backup table');const columns=this.store.all(`PRAGMA table_info(${table})`).map(c=>c.name);for(const row of rows){if(Object.keys(row).some(k=>!columns.includes(k)))throw new AppError('INVALID_BACKUP','Backup schema does not match');const names=Object.keys(row);this.store.run(`INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map(()=>'?').join(',')})`,...names.map(name=>blobColumns.has(name)?Buffer.from(row[name],'base64'):row[name]));}}
      for(const row of this.store.all('SELECT id FROM secret_records'))this.vault.read(row.id);
      this.store.run("UPDATE instance_runtime SET state='stopped'");
    })();
    }catch(error){this.vault.restoreKeys(previous);throw error;}
    this.vault.restoreKeys({active:data.keys.active,keys:{...previous.keys,...data.keys.keys}});
  }
}
