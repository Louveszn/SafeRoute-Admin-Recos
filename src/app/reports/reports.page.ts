import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { IonicModule, AlertController, ToastController } from '@ionic/angular';
import {
  Firestore,
  collection,
  collectionData,
  doc,
  deleteDoc,
  updateDoc,
  query,
  where,
  getDoc,
  getDocs,
} from '@angular/fire/firestore';
import { BehaviorSubject, Observable, combineLatest, map, switchMap } from 'rxjs';

type ReportStatus = 'pending' | 'verified' | 'resolved' | 'rejected';

interface Report {
  id: string;
  category: string;
  location?: string;
  datetime: number | string | any;
  status: ReportStatus;
  description?: string;
  barangay: string;
  landmark?: string;
  lat?: number;
  lng?: number;
  _dt?: number;
  userId?: string;
  reportedBy?: string;
  createdBy?: string;
  userName?: string;
  userAddress?: string;
  userContact?: string;
}

interface UserInfo {
  name: string;
  address: string;
  contact: string;
}

@Component({
  selector: 'app-reports',
  templateUrl: './reports.page.html',
  styleUrls: ['./reports.page.scss'],
  standalone: true,
  imports: [IonicModule, CommonModule, FormsModule],
})
export class ReportsPage {
  role: 'super_admin' | 'barangay_admin' = 'barangay_admin';
  barangay = '';
  barangayOptions = ['All Barangays', 'Carig Sur', 'Carig Norte', 'Linao East', 'Linao West', 'Linao Norte'];
  selectedBarangay = 'All Barangays';
  private barangayFilter$ = new BehaviorSubject<string>('All Barangays');

  activeTab: ReportStatus = 'pending';
  private tab$ = new BehaviorSubject<ReportStatus>('pending');
  searchTerm = '';
  private search$ = new BehaviorSubject<string>('');
  sortOrder: 'asc' | 'desc' = 'desc';
  private sort$ = new BehaviorSubject<'asc' | 'desc'>('desc');

  reports$: Observable<Report[]>;
  filtered$: Observable<Report[]>;

  summaryOpen = false;
  selected: Report | null = null;

  currentAdminName = '';
  
  private userCache = new Map<string, UserInfo>();

  constructor(
    private fs: Firestore,
    private alertCtrl: AlertController,
    private toastCtrl: ToastController
  ) {
    this.role = (localStorage.getItem('role') as any) || 'barangay_admin';
    this.barangay = this.normalizeBarangay(localStorage.getItem('barangay') || 'Carig Sur');
    this.currentAdminName = localStorage.getItem('adminName') || `${this.barangay} Barangay Admin`;

    const colRef = collection(this.fs, 'reports');
    const base = this.role === 'super_admin'
      ? colRef
      : query(colRef, where('barangay', '==', this.barangay));

    const baseReports$ = collectionData(base, { idField: 'id' }) as Observable<Report[]>;
    
    this.reports$ = baseReports$.pipe(
      switchMap((reports) => {
        console.log(`Processing ${reports.length} reports...`);
        
        const enrichmentPromises = reports.map(async (report) => {
          console.log(`Processing report ${report.id}: userId=${report.userId}, reportedBy=${report.reportedBy}, createdBy=${report.createdBy}`);
          
          if (report.reportedBy === 'admin') {
            console.log(`Report ${report.id} was reported by admin`);
            return {
              ...report,
              userName: this.currentAdminName,
              userAddress: `${report.barangay} Barangay Office`,
              userContact: '—'
            };
          }
          
          if (report.userId) {
            const userInfo = await this.fetchUserInfo(report.userId);
            
            if (userInfo.name.startsWith('Unknown User') && report.createdBy) {
              console.log(`UserId ${report.userId} not found, searching by email: ${report.createdBy}`);
              const userByEmail = await this.findUserByEmail(report.createdBy);
              if (userByEmail) {
                return {
                  ...report,
                  userName: userByEmail.name,
                  userAddress: userByEmail.address,
                  userContact: userByEmail.contact
                };
              }
              
              const adminInfo = await this.checkIfCreatedByAdmin(report.createdBy, report.barangay);
              if (adminInfo) {
                return {
                  ...report,
                  userName: adminInfo.name,
                  userAddress: adminInfo.address,
                  userContact: '—'
                };
              }
            }
            
            return {
              ...report,
              userName: userInfo.name,
              userAddress: userInfo.address,
              userContact: userInfo.contact
            };
          }
          
          if (report.createdBy) {
            const userByEmail = await this.findUserByEmail(report.createdBy);
            if (userByEmail) {
              return {
                ...report,
                userName: userByEmail.name,
                userAddress: userByEmail.address,
                userContact: userByEmail.contact
              };
            }
            
            const adminInfo = await this.checkIfCreatedByAdmin(report.createdBy, report.barangay);
            if (adminInfo) {
              return {
                ...report,
                userName: adminInfo.name,
                userAddress: adminInfo.address,
                userContact: '—'
              };
            }
          }
          
          return {
            ...report,
            userName: '—',
            userAddress: '—',
            userContact: '—'
          };
        });
        
        return Promise.all(enrichmentPromises);
      })
    );

    this.filtered$ = combineLatest([
      this.reports$, this.tab$, this.search$, this.sort$, this.barangayFilter$
    ]).pipe(
      map(([rows, tab, q, order, brgySel]) => {
        const term = (q || '').trim().toLowerCase();
        const selected = this.normalizeBarangay(brgySel || 'All Barangays');
        return rows
          .filter(r => (r.status || 'pending') === tab)
          .filter(r =>
            !term
              ? true
              : (r.category || '').toLowerCase().includes(term) ||
                (r.location || '').toLowerCase().includes(term) ||
                (r.landmark || '').toLowerCase().includes(term) ||
                (r.barangay || '').toLowerCase().includes(term) ||
                (r.description || '').toLowerCase().includes(term) ||
                (r.userName || '').toLowerCase().includes(term)
          )
          .filter(r => {
            if (this.role !== 'super_admin') return true;
            if (!selected || selected === 'All Barangays') return true;
            return this.normalizeBarangay(r.barangay || '') === selected;
          })
          .map(r => ({ ...r, _dt: this.toMillis(r.datetime) }))
          .sort((a, b) =>
            order === 'desc' ? (b._dt || 0) - (a._dt || 0) : (a._dt || 0) - (b._dt || 0)
          );
      })
    );
  }

  setTab(tab: ReportStatus) { this.activeTab = tab; this.tab$.next(tab); }
  onSearch(q: string) { this.search$.next(q ?? ''); }
  onBarangayChange(v: string) { this.selectedBarangay = v; this.barangayFilter$.next(v || 'All Barangays'); }
  toggleSort() { this.sortOrder = this.sortOrder === 'desc' ? 'asc' : 'desc'; this.sort$.next(this.sortOrder); }

  async openSummary(r: Report) { 
    this.selected = r;
    this.summaryOpen = true;
  }
  
  closeSummary() { 
    this.summaryOpen = false; 
    this.selected = null;
  }

printReports() {
  const table = document.querySelector<HTMLTableElement>('#print-area table');
  if (!table) { window.print(); return; }

  const clone = table.cloneNode(true) as HTMLTableElement;

  // remove Actions + Status columns (7th & 8th)
  const removeColIndexes = [6, 7];
  Array.from(clone.rows).forEach(row =>
    removeColIndexes.slice().sort((a,b)=>b-a).forEach(i => row.cells[i] && row.deleteCell(i))
  );

  const html = `
    <html>
      <head>
        <meta charset="utf-8" />
        <title>SafeRoute Incident Report</title>
        <style>
          @page { 
            margin: 15mm;
            size: A4;
          } 

          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }

          html, body { 
            height: 100%;
            width: 100%;
          }
          
          body {
            font-family: Arial, Helvetica, sans-serif;
            font-size: 11pt;          
            line-height: 1.4;
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 20pt;
          }

          .header {
            text-align: center;
            margin-bottom: 20pt;
            width: 100%;
          }

          .header h1 {
            font-size: 22pt;
            font-weight: bold;
            margin-bottom: 4pt;
            color: #1a1a1a;
          }

          .header h2 {
            font-size: 16pt;
            font-weight: 600;
            color: #444;
          }

          .content-wrapper {
            width: 100%;
            max-width: 1000px;
            margin: 0 auto;
          }
          
          table {
            width: 100%;
            border-collapse: collapse;
            table-layout: auto;
            margin: 0 auto;
          }
          
          th, td {
            border: 1px solid #999;
            padding: 8pt 10pt;         
            vertical-align: top;
            text-align: left;
          }
          
          th {
            font-size: 11pt;
            font-weight: 700;
            background: #f0f0f0;
          }

          td {
            font-size: 10pt;
          }
          
          /* Avoid splitting rows across pages */
          tr, td, th { 
            page-break-inside: avoid; 
          }

          /* Center text in specific columns if needed */
          td:nth-child(5), td:nth-child(6) {
            text-align: center;
          }
        </style>
      </head>
      <body>
        <div class="content-wrapper">
          <div class="header">
            <h1>SafeRoute</h1>
            <h2>Incident Report</h2>
          </div>
          ${clone.outerHTML}
        </div>
      </body>
    </html>
  `;

  const w = window.open('', '_blank', 'width=1100,height=1400');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
  w.close();
}

  printSummary() {
    // Hide menu and add print class
    this.hideMenuForPrint();
    document.body.classList.add('print-summary-mode');
    
    setTimeout(() => {
      window.print();
      // Remove class after print dialog closes
      setTimeout(() => {
        document.body.classList.remove('print-summary-mode');
        this.restoreMenuAfterPrint();
      }, 1000);
    }, 100);
  }

  private hideMenuForPrint() {
    // Find and hide all menu elements
    const menus = document.querySelectorAll('ion-menu, ion-split-pane ion-menu, [slot="start"]');
    menus.forEach((menu: any) => {
      menu.style.display = 'none';
      menu.style.visibility = 'hidden';
      menu.setAttribute('data-print-hidden', 'true');
    });
    
    // Force split-pane to full width
    const splitPanes = document.querySelectorAll('ion-split-pane');
    splitPanes.forEach((pane: any) => {
      pane.style.setProperty('--side-width', '0px', 'important');
    });
    
    // Make content full width
    const contents = document.querySelectorAll('ion-content, .main-content');
    contents.forEach((content: any) => {
      content.style.marginLeft = '0';
      content.style.width = '100%';
    });
  }

  private restoreMenuAfterPrint() {
    // Restore hidden menus
    const hiddenMenus = document.querySelectorAll('[data-print-hidden="true"]');
    hiddenMenus.forEach((menu: any) => {
      menu.style.display = '';
      menu.style.visibility = '';
      menu.removeAttribute('data-print-hidden');
    });
    
    // Restore split-pane
    const splitPanes = document.querySelectorAll('ion-split-pane');
    splitPanes.forEach((pane: any) => {
      pane.style.removeProperty('--side-width');
    });
    
    // Restore content
    const contents = document.querySelectorAll('ion-content, .main-content');
    contents.forEach((content: any) => {
      content.style.marginLeft = '';
      content.style.width = '';
    });
  }

  async checkIfCreatedByAdmin(email: string, reportBarangay: string): Promise<UserInfo | null> {
    try {
      console.log(`Checking if ${email} is an admin`);
      
      const adminsRef = collection(this.fs, 'admins');
      const q = query(adminsRef, where('email', '==', email));
      const querySnapshot = await getDocs(q);
      
      if (!querySnapshot.empty) {
        const adminData = querySnapshot.docs[0].data();
        console.log(`Found admin:`, adminData);
        
        const barangayName = this.normalizeBarangay(reportBarangay || adminData['barangay'] || 'Unknown');
        
        return {
          name: adminData['name'] || adminData['fullName'] || `${barangayName} Admin`,
          address: `${barangayName}, Barangay Hall`,
          contact: '—'
        };
      }
      
      console.log(`${email} is not an admin`);
      return null;
    } catch (error) {
      console.error('Error checking admin status:', error);
      return null;
    }
  }

  async findUserByEmail(email: string): Promise<UserInfo | null> {
    try {
      console.log(`Searching for user by email: ${email}`);
      
      const usersRef = collection(this.fs, 'users');
      const q = query(usersRef, where('email', '==', email));
      const querySnapshot = await getDocs(q);
      
      if (!querySnapshot.empty) {
        const userData = querySnapshot.docs[0].data();
        console.log(`Found user by email:`, userData['username'] || userData['name']);
        
        const userInfo: UserInfo = {
          name: userData['name'] || userData['fullName'] || userData['displayName'] || userData['username'] || userData['email']?.split('@')[0] || '—',
          address: userData['address'] || '—',
          contact: userData['phone'] || userData['contact'] || userData['phoneNumber'] || '—'
        };
        
        return userInfo;
      }
      
      console.log(`No user found with email: ${email}`);
      return null;
    } catch (error) {
      console.error('Error finding user by email:', error);
      return null;
    }
  }

  async fetchUserInfo(userId: string): Promise<UserInfo> {
    if (this.userCache.has(userId)) {
      console.log(`Using cached user info for ${userId}`);
      return this.userCache.get(userId)!;
    }

    console.log(`Fetching user info for ${userId}`);
    try {
      const userDocRef = doc(this.fs, 'users', userId);
      const userDoc = await getDoc(userDocRef);
      
      let userInfo: UserInfo;
      
      if (userDoc.exists()) {
        const userData = userDoc.data();
        userInfo = {
          name: userData['name'] || userData['fullName'] || userData['displayName'] || userData['username'] || userData['email']?.split('@')[0] || '—',
          address: userData['address'] || '—',
          contact: userData['phone'] || userData['contact'] || userData['phoneNumber'] || '—'
        };
        console.log(`Successfully fetched user ${userId}:`, userInfo.name);
      } else {
        console.warn('User document not found for userId:', userId);
        userInfo = {
          name: `Unknown User (${userId.substring(0, 8)}...)`,
          address: '—',
          contact: '—'
        };
      }
      
      this.userCache.set(userId, userInfo);
      return userInfo;
      
    } catch (error: any) {
      console.error('Error fetching user info:', error);
      
      const fallbackInfo: UserInfo = {
        name: error?.code === 'permission-denied' ? 'Permission Denied' : '—',
        address: '—',
        contact: '—'
      };
      
      this.userCache.set(userId, fallbackInfo);
      return fallbackInfo;
    }
  }

  getReporterInfo(): { name: string; address: string; contact: string } {
    if (!this.selected) {
      return { name: '—', address: '—', contact: '—' };
    }

    return {
      name: this.selected.userName || '—',
      address: this.selected.userAddress || '—',
      contact: this.selected.userContact || '—'
    };
  }

  async confirmStatusChange(r: Report, status: ReportStatus) {
    const action = status === 'verified' ? 'verify' : status === 'resolved' ? 'resolve' : 'reject';
    const alert = await this.alertCtrl.create({
      header: 'Confirmation',
      message: `Are you sure you want to ${action} this report?`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Yes',
          handler: () => this.markStatus(r, status),
        },
      ],
    });
    await alert.present();
  }

  async confirmDelete(id: string) {
    const alert = await this.alertCtrl.create({
      header: 'Delete Report',
      message: 'Are you sure you want to permanently delete this report?',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Delete',
          role: 'destructive',
          handler: () => this.deleteReport(id),
        },
      ],
    });
    await alert.present();
  }

  async markStatus(r: Report, status: ReportStatus) {
    try {
      await updateDoc(doc(this.fs, 'reports', r.id), { status });
      this.toast(`Marked ${status}.`);
      if (this.selected?.id === r.id) this.selected.status = status;
    } catch (e: any) {
      this.toast(e?.message || 'Could not update status.', true);
    }
  }

  async deleteReport(id: string) {
    try {
      await deleteDoc(doc(this.fs, 'reports', id));
      this.toast('Report deleted.');
      this.closeSummary();
    } catch (e: any) {
      this.toast(e?.message || 'Could not delete report.', true);
    }
  }

  private normalizeBarangay(name: string): string {
    const s = (name || '').trim().toLowerCase();
    if (s.startsWith('carig sur')) return 'Carig Sur';
    if (s.startsWith('carig norte')) return 'Carig Norte';
    if (s.startsWith('linao east')) return 'Linao East';
    if (s.startsWith('linao west')) return 'Linao West';
    if (s.startsWith('linao norte')) return 'Linao Norte';
    if (s === 'all barangays' || s === 'all') return 'All Barangays';
    return (name || '').trim();
  }

  private toMillis(dt: any): number {
    if (!dt) return 0;
    if (typeof dt === 'number') return dt < 1e12 ? dt * 1000 : dt;
    if (dt && typeof dt.seconds === 'number')
      return dt.seconds * 1000 + Math.floor((dt.nanoseconds || 0) / 1e6);
    const n = Date.parse(dt);
    return isNaN(n) ? 0 : n;
  }

  dateOnly(dt: any): string {
    const ms = this.toMillis(dt);
    if (!ms) return '—';
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'numeric', day: '2-digit' });
  }

  timeOnly(dt: any): string {
    const ms = this.toMillis(dt);
    if (!ms) return '';
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  badgeClass(status?: ReportStatus) {
    const s = status || 'pending';
    return {
      pending: 'badge badge--pending',
      verified: 'badge badge--verified',
      resolved: 'badge badge--resolved',
      rejected: 'badge badge--rejected',
    }[s];
  }

  private async toast(message: string, danger = false) {
    const t = await this.toastCtrl.create({
      message,
      duration: 1500,
      color: danger ? 'danger' : 'dark',
      position: 'bottom',
    });
    await t.present();
  }
}