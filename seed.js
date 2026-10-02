import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
const db=new PrismaClient();
const hash=await bcrypt.hash('Manager123!',10); const staffHash=await bcrypt.hash('Staff123!',10);
const supplier=await db.supplier.upsert({where:{name:'Ali Traders'},update:{},create:{name:'Ali Traders'}});
await db.user.upsert({where:{email:'manager@stocksense.local'},update:{},create:{name:'Mall Manager',email:'manager@stocksense.local',passwordHash:hash,role:Role.MANAGER}});
await db.user.upsert({where:{email:'staff@stocksense.local'},update:{},create:{name:'Store Staff',email:'staff@stocksense.local',passwordHash:staffHash,role:Role.STAFF}});
for(const p of [{sku:'ELEC-TC-001',name:'Type-C Cable',category:'Electronics',quantity:15,reorderLevel:10,costPrice:180,salePrice:300},{sku:'GROC-TEA-001',name:'Tea Pack',category:'Grocery',quantity:8,reorderLevel:12,costPrice:220,salePrice:280},{sku:'HOME-BULB-001',name:'LED Bulb',category:'Household',quantity:30,reorderLevel:8,costPrice:120,salePrice:200}]) await db.product.upsert({where:{sku:p.sku},update:{},create:{...p,supplierId:supplier.id}});
console.log('Seeded demo users and products'); await db.$disconnect();
