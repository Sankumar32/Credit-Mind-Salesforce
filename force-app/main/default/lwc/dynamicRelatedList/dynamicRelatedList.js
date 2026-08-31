import { LightningElement, api, wire, track } from 'lwc';
import { getObjectInfo } from 'lightning/uiObjectInfoApi';
import { getRelatedListInfo, getRelatedListRecords } from 'lightning/uiRelatedListApi';
import { updateRecord } from 'lightning/uiRecordApi';
import { refreshApex } from '@salesforce/apex';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';

const DATATYPE_TO_COLUMN_TYPE = {
    String: 'text', TextArea: 'text', LongTextArea: 'text', RichTextArea: 'text', ComboBox: 'text',
    Currency: 'currency', Date: 'date-local', DateTime: 'date', Boolean: 'boolean',
    Integer: 'number', Double: 'number', Long: 'number', Percent: 'percent',
    Phone: 'phone', Email: 'email', Url: 'url',
    Picklist: 'text', MultiselectPicklist: 'text', Reference: 'text', ID: 'text',
};

export default class DynamicRelatedList extends LightningElement {
    @api recordId;
    @api objectApiName;   // parent object (auto-injected on record pages)
    @api relatedListId;   // relationship API name, e.g. "Contacts"
    @api editable = false;
    @api showAddButton = false;
    @api hideCheckboxColumn = false;
    @api enableInfiniteLoading = false;
    @api height;
    @api iconName;
    @api pageSize = 20;
    @api childRecordField;  // field on child to pre-fill when creating a new record

    _title;
    @api get title() { return this._title; }
    set title(v) { this._title = v; }

    @track _sObject;
    @api get sObject() { return this._sObject; }
    set sObject(v) {
        this._sObject = v;
        this._updateFieldsToFetch();
        this._updateSortByParam();
    }

    @track _customFields = [];
    _useCustomFields = false;
    @api get fields() { return this._customFields.join(','); }
    set fields(v) {
        const arr = typeof v === 'string'
            ? v.split(',').map(f => f.trim()).filter(Boolean)
            : (Array.isArray(v) ? v : []);
        this._customFields = arr;
        this._useCustomFields = arr.length > 0;
        this._updateFieldsToFetch();
    }

    @track _sortedBy = 'Name';
    @api get sortedBy() { return this._sortedBy; }
    set sortedBy(v) { this._sortedBy = v; this._updateSortByParam(); }

    @track _sortedDirection = 'asc';
    @api get sortedDirection() { return this._sortedDirection; }
    set sortedDirection(v) { this._sortedDirection = v; this._updateSortByParam(); }

    @track _fieldsToFetch = [];
    @track _sortByParam = [];
    @track _objectInfo;
    @track _relatedListInfoData;
    @track tableData = [];
    @track tableColumns = [];
    @track draftValues = [];
    @track saveErrors = {};
    @track isLoading = true;
    @track isLoadingMore = false;
    @track showModal = false;
    @track errorMessage;

    _wiredRecords;
    _allRecordsLoaded = false;

    @wire(getObjectInfo, { objectApiName: '$_sObject' })
    wiredObjectInfo({ data, error }) {
        if (data) {
            this._objectInfo = data;
            this._buildColumns();
        } else if (error) {
            this.errorMessage = error.body?.message || 'Error loading object metadata.';
            this.isLoading = false;
        }
    }

    @wire(getRelatedListInfo, {
        parentObjectApiName: '$objectApiName',
        relatedListId: '$relatedListId'
    })
    wiredRelatedListInfo({ data }) {
        if (data) {
            this._relatedListInfoData = data;
            if (!this._useCustomFields) {
                this._fieldsToFetch = data.displayColumns
                    .filter(c => c.fieldApiName)
                    .map(c => c.fieldApiName);
            }
            this._buildColumns();
        }
    }

    @wire(getRelatedListRecords, {
        parentRecordId: '$recordId',
        relatedListId: '$relatedListId',
        fields: '$_fieldsToFetch',
        sortBy: '$_sortByParam',
        pageSize: '$pageSize'
    })
    wiredRelatedListRecords(result) {
        this._wiredRecords = result;
        const { data, error } = result;
        if (data) {
            this.tableData = this._flattenRecords(data.records);
            this._allRecordsLoaded = !data.nextPageToken;
            this.isLoading = false;
        } else if (error) {
            this.errorMessage = error.body?.message || 'Error loading records.';
            this.isLoading = false;
        }
    }

    _updateFieldsToFetch() {
        if (this._useCustomFields && this._sObject) {
            this._fieldsToFetch = this._customFields.map(f =>
                f.includes('.') ? f : `${this._sObject}.${f}`
            );
        }
    }

    _updateSortByParam() {
        if (!this._sortedBy || !this._sObject) return;
        const prefix = this._sortedDirection === 'desc' ? '-' : '';
        this._sortByParam = [`${prefix}${this._sObject}.${this._sortedBy}`];
    }

    _buildColumns() {
        if (!this._objectInfo) return;

        const fieldNames = this._useCustomFields
            ? this._customFields.map(f => f.includes('.') ? f.split('.').pop() : f)
            : (this._relatedListInfoData?.displayColumns?.map(c => {
                const parts = c.fieldApiName.split('.');
                return parts[parts.length - 1];
            }) || []);

        if (!fieldNames.length) return;

        const objFields = this._objectInfo.fields;
        this.tableColumns = fieldNames
            .filter(name => name && name.toLowerCase() !== 'id')
            .map(cleanName => {
                const meta = objFields[cleanName];
                const type = DATATYPE_TO_COLUMN_TYPE[meta?.dataType] || 'text';
                const col = {
                    label: meta?.label || cleanName,
                    fieldName: cleanName,
                    type,
                    sortable: meta?.sortable ?? false,
                };
                if (this.editable && meta?.updateable) {
                    col.editable = true;
                }
                if (type === 'currency') {
                    col.typeAttributes = { currencyCode: 'USD', step: '0.01' };
                } else if (type === 'date-local') {
                    col.typeAttributes = { year: 'numeric', month: '2-digit', day: '2-digit' };
                } else if (type === 'date') {
                    col.typeAttributes = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };
                }
                return col;
            });
    }

    _flattenRecords(records) {
        return (records || []).map(rec => {
            const flat = { Id: rec.id };
            Object.entries(rec.fields || {}).forEach(([key, fObj]) => {
                flat[key] = (fObj.displayValue != null) ? fObj.displayValue : fObj.value;
            });
            return flat;
        });
    }

    get cardTitle() {
        if (this._title) return this._title;
        if (this._relatedListInfoData?.label) return this._relatedListInfoData.label;
        return this._objectInfo?.labelPlural || this._sObject || '';
    }

    get currentSortedBy() { return this._sortedBy; }
    get currentSortedDirection() { return this._sortedDirection; }
    get hasError() { return !!this.errorMessage; }
    get hasData() { return !!(this.tableData && this.tableData.length); }
    get showEmptyMessage() { return !this.isLoading && !this.hasError && !this.hasData; }
    get containerStyle() { return this.height ? `height:${this.height}px;overflow-y:auto;` : ''; }
    get newRecordTitle() { return `New ${this._objectInfo?.label || this._sObject || 'Record'}`; }

    get formFields() {
        if (!this._customFields.length) return null;
        return this._customFields.filter(f => !f.includes('.') && f.toLowerCase() !== 'id');
    }

    get hasFormFields() { return !!(this.formFields && this.formFields.length); }

    get defaultFieldValues() {
        if (this.childRecordField && this.recordId) {
            return { [this.childRecordField]: this.recordId };
        }
        return undefined;
    }

    handleSort(event) {
        this._sortedBy = event.detail.fieldName;
        this._sortedDirection = event.detail.sortDirection;
        this._updateSortByParam();
    }

    async handleSave(event) {
        this.isLoading = true;
        try {
            await Promise.all(event.detail.draftValues.map(rec => updateRecord({ fields: rec })));
            this.draftValues = [];
            this.saveErrors = {};
            this._showToast('Success', 'Records updated successfully.', 'success');
            await refreshApex(this._wiredRecords);
        } catch (err) {
            const msg = err.body?.output?.errors?.[0]?.message || err.body?.message || 'Error saving records.';
            this._showToast('Error', msg, 'error');
        } finally {
            this.isLoading = false;
        }
    }

    handleCellChange(event) { this.draftValues = [...event.detail.draftValues]; }

    handleCancelEdit() {
        this.draftValues = [];
        this.saveErrors = {};
    }

    handleLoadMore(event) {
        if (this._allRecordsLoaded) {
            event.target.enableInfiniteLoading = false;
        }
    }

    handleRefresh() {
        this.isLoading = true;
        refreshApex(this._wiredRecords)
            .catch(err => { this.errorMessage = err.body?.message || 'Refresh failed.'; })
            .finally(() => { this.isLoading = false; });
    }

    @api refresh() { this.handleRefresh(); }

    handleNew() { this.showModal = true; }
    handleCloseModal() { this.showModal = false; }

    handleSuccess() {
        this.showModal = false;
        this._showToast('Success', 'Record created successfully.', 'success');
        refreshApex(this._wiredRecords);
    }

    _showToast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}